# 0040: Deploy the API and worker to Northflank

- **Status:** accepted
- **Date:** 2026-11-05
- **Decided by:** Dave
- **Related:** issue #7, #71, #73, #74, #75, #76; ADR 0036 (container image), ADR 0037 (read replicas), ADR 0038 (team cache), ADR 0039 (Sentry)

## Problem

Rota needs a host for the API and the worker. The stack rule (`AGENTS.md`) requires every piece of
application infrastructure beyond the domain itself to stay on a free plan, with no expiring trial
credits.

## Options considered

1. **Northflank** — Developer Sandbox, "Free platform plan": $20/mo of free resources, 2 services, 2
   jobs, 1 addon. A payment method is required for verification — Northflank's own wording: "Payment
   method required ... You will not be charged for this service." Dave added one and froze it; any
   actual charge needs an explicit "Upgrade to Pay as you go" click, which he will not make. Region
   Europe West (London).
2. **Oracle Cloud Always Free** — the brief's usual free-tier fallback. Dave's sign-up attempt was
   rejected with a generic "error creating your account", unrelated to Oracle's idle-reclaim policy.
   Stays documented as the fallback; not an active path while the card used is frozen.
3. **Other free hosts**, ruled out 2026-10-15 for sleeping on idle, or being trial-only/paid, without
   further evaluation: Render, Koyeb, Zeabur, Hugging Face Spaces, Railway, Fly.io, Replit, Clever
   Cloud, Sevalla.

## Decision

Northflank. Two Combined services, `rota-api` and `rota-worker`, built from the same Dockerfile
(ADR 0036) with a start-command override on the worker. Both on plan `nf-compute-20` (0.2 vCPU, 512 MB
RAM, confirmed from Northflank's own plan docs and pricing page — about $5.40/mo each, ~$10.80/mo
together, inside the $20/mo free allowance). Recreate rollout strategy on both (stop-then-start,
required by the one-process rule in `data.md`). Region Europe West (London) — close to both Neon
shards (AWS eu-west-2, London) and the Aiven Valkey instance (DigitalOcean, Amsterdam).

## Why

**The Northflank security incident.** Northflank disclosed an incident beginning 30 October 2026,
status "Monitoring" as of 2 November: an attacker targeted secrets held in Northflank's own control
plane, and customers were told to assume their environment variables had been decrypted. Northflank
says it was contained within an hour and rotated its own keys. Dave has screenshots of the disclosure.

Checked before accepting the risk: Rota's Northflank account held no secrets at the time (the Secrets
page was empty; the audit log showed only Dave's two project-setup events from 16 October, before any
credential existed). The residual risk is also bounded by what Rota actually exposes here: Stripe test
mode only, demo data only, every dependency on a free plan. Dave accepted the risk on this basis, with
the mitigation below.

**Mitigation — every deploy credential is new, least-privilege where the provider allows it, and
separately rotatable from local dev:**

- **Stripe:** a restricted test-mode key (`rota-deploy-api`) with Checkout Sessions (Write), Payment
  Intents (Write), Setup Intents (Read), Payment Methods (Read) — this set verified as sufficient by a
  real Checkout session and a real card-save proof (PR #74). A new webhook endpoint and signing secret,
  created in step 5 of the deploy (replacing a placeholder used until then).
- **Resend:** a sending-only key, restricted to the `rota.davebuilds.design` sending domain — verified
  with a real invite email, sent and received.
- **Neon:** a new role, `rota_deploy_api`, created on both shards. It has full project access — the
  Neon Console's own default for any new role (`neon_superuser` privileges); the Console does not offer
  a narrower one. Separated from Dave's own role for rotation, not for least privilege. Verified
  read/write and correct primary/replica recovery state (`pg_is_in_recovery()`) on all four connection
  strings.
- **Valkey (Aiven):** a new ACL user, `rota_deploy`. Started from `+@all -@admin`, then tightened after
  finding `-@admin` does not cover the `@dangerous` category (commands like `FLUSHALL`/`FLUSHDB` take no
  key argument, so no pattern scopes them) — the dangerous commands the app doesn't use are now
  individually denied. `CONFIG` is denied outright: Aiven's ACL engine did not honour a
  subcommand-scoped `+config|get` rule in practice (`CONFIG GET` returned "unknown command" instead of
  succeeding), so `jobs/connection.ts`'s `verifyNoEviction` was changed to read `maxmemory_policy` from
  `INFO memory` only (PR #75), and `CONFIG` is denied completely rather than fought further.
- **GitHub:** Northflank's GitHub App access is limited to `Hennit-Dave/rota` only.
- All of the above are rotated after submission, or immediately if Northflank's root-cause report for
  the incident turns out to warrant it sooner.

**Stripe webhook API version.** `server/src/billing/gateway.ts` does not pin `apiVersion` on the Stripe
client; it defaults to whatever the installed SDK build pins internally — confirmed from
`stripe@23.0.1`'s own source (`node_modules/stripe/cjs/apiVersion.js`) as `2026-09-30.endive`. That
exact dated version is not offered in the Stripe Dashboard's webhook-destination version picker, which
only lists `2026-07-29.dahlia` (the account's current default), `2026-10-28.endive` (latest), and a
preview version. Dave chose **`2026-10-28.endive`**: the same named release line ("endive") as the
SDK's own pin, just a later date within it, on the basis that Stripe's versioning keeps the same
codename across non-breaking additive changes. Treated as unverified until proven, not assumed correct
by that reasoning alone — see the deployment gate's first check.

## Consequences

- Deploying either service always means a full stop-then-start (Recreate), never a rolling swap;
  confirmed available on Northflank's free plan.
- **Pausing a Northflank service switches its CI and CD off too** (found while pausing `rota-worker`
  for deployment-gate check 3). Turn both back on after Resume, or the next push won't auto-deploy.
- The Neon deploy role is not least-privilege (full project access, not scoped to Rota's own tables).
  Revisit if Neon ever offers a narrower role.
- The `CONFIG` command is fully denied to the deploy Valkey user; any future feature that needs to read
  a Valkey server setting at runtime must do it via `INFO`, the way `verifyNoEviction` now does, not
  `CONFIG GET`.
- Revisit this decision if: Northflank's incident root-cause report shows risk beyond what was accepted
  here; the "$20/mo of free resources" turns out to be a time-limited trial rather than a standing
  monthly allowance (Dave has asked Northflank support to confirm this in writing); or either service
  needs more than 512 MB.

## Evidence

- API live: build `adroit-snails-5405`, commit `f19fcc3`, 1 instance, Recreate, readiness probe
  `/health`, 0 restarts, 146/512 MB idle. `GET /health` on
  `https://p01--rota-api--76m4b9xbxd4k.code.run` returns `{"ok":true}` (screenshot held by Dave).
- Custom domain confirmed (2026-11-05): `api.rota.davebuilds.design` verified on Northflank's Domains
  page, Cloudflare CNAME `api.rota` (DNS only, not proxied), routed to `rota-api` port 3000.
  `GET https://api.rota.davebuilds.design/health` returns `{"ok":true}` (screenshot held by Dave). The
  app's `EXPO_PUBLIC_API_URL` uses this domain, not the raw `*.code.run` address.
- Worker live: build `adaptable-drink-6295`, commit `f19fcc3`, 1 instance, Recreate, custom command
  `node --enable-source-maps dist/worker/main.js`, no port, 0 restarts. Logs confirm: Valkey connected
  and `maxmemory-policy` verified as `noeviction`; running against the real shards; Sentry on
  (environment production); the reconciliation sweep ran at startup on both shards (0 recovered); and
  `ensureRenewals` created 1 renewal for a subscription that had none yet — the same idempotent sweep
  the issue #71 fix made safe, now proven for the first time against real data.
- Credential proofs: Stripe (PR #74), Resend (invite email confirmed received by Dave — sender,
  reply-to, subject, body and expiry correct), Neon (read/write + recovery-state script, pass on all 4
  strings, no value printed), Valkey (9/9 checks pass including the compiled `verifyNoEviction`, PR
  #75).
- Stripe webhook API-version proof: **proven** — the deployment gate's first check (`AGENTS.md`, full
  evidence in PR #77): a real Stripe event (`checkout.session.completed`, `payment_intent.succeeded`,
  both 200 OK) received by the deployed webhook, verified, durably recorded, and processed end-to-end
  by the deployed worker (`outcome=applied`, `detail=activation_applied`, `card_inserted`).
- Deployment-gate checks 2–5, all proven, full evidence in PR #77: stop-then-start (`rota-api`
  Restart, old pod's `api closed` strictly before the new pod's `api listening`, no overlap);
  worker-restart recovery (`rota-worker` Pause/Resume, work created during the outage stayed pending
  until Resume, then was sent); one Resend email from the deployed worker (the same event — sender,
  reply-to, subject, link and expiry confirmed correct); queue-loss recovery (a delayed job's BullMQ
  entry deleted from the real Valkey while `rota-worker` kept running untouched, restored and
  completed by the reconnect-triggered reconciliation sweep — not the 30-minute timer, which ran
  afterward and found nothing to do).
- **`AUTH_JWT_SECRET` rotated early (2026-11-06), ahead of the general post-submission rotation this
  ADR already planned.** Reason: the k6 load test (`load-tests/`) needed 200 pre-issued, locally-minted
  sessions whose access tokens the *deployed* API would actually verify — the first attempt minted
  them with local dev's own `AUTH_JWT_SECRET` and every one of 200 VUs got a 401 (confirmed by
  decoding the rejected token: `iss`/`aud`/`exp`/`sub`/`sid` all correct, session active in Postgres —
  the signature itself was the only thing that could still be wrong, and local dev's secret is
  deliberately different from the deployed one, matching this ADR's own per-deploy-credential
  philosophy). Fix: Dave pasted the deployed value into a new, local-only `K6_DEPLOY_AUTH_JWT_SECRET`
  env var for the run's duration — never synced with local `AUTH_JWT_SECRET`, never printed, deleted
  from `.env` once the runs finished. Northflank's `AUTH_JWT_SECRET` was then rotated to a fresh
  `openssl rand -base64 32` value and `rota-api` restarted and confirmed healthy. Full k6 results:
  `load-tests/REPORT.md`.
- Known, non-blocking follow-up: deployed Postgres connections use `sslmode=require` (TLS, no
  certificate verification); Postgres's own deprecation warning for this appeared in the worker's
  stderr on first boot. Tracked as issue #76 (move to `sslmode=verify-full`).
