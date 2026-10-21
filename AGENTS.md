# Rota — agent instructions (canonical)

This file is the single source of truth for every coding agent on this repo.
Two agents are in use: Antigravity's own agent and Claude Code. Whichever is running
follows these exact rules, so switching agents mid-feature changes nothing.

- `CLAUDE.md` files contain only `@AGENTS.md`. Never put rules in them.
- Never create `GEMINI.md`, `.claude/rules/`, or a copy of any rule. Change the canonical file instead.
- `app/AGENTS.md` and `server/AGENTS.md` add folder rules. Where they conflict with this file, stop and ask.

## Requirement sources

- `/Users/blk/Downloads/final-graduation-task (1).pdf` — the original graduation brief. Highest authority for
  assignment requirements. Never edit it. Kept outside the repo; never commit a copy.
- `docs/requirements/ROTA-BUILD-PROMPT.md` — a build prompt derived from the brief. Where it disagrees with
  the brief, the brief wins and the build prompt gets corrected.
- If either file is missing or unreadable, say so and stop. Never write requirement-specific rules or code
  from memory of a spec you cannot open.
- If a rules file this document points to does not exist yet, report it and complete that rules file before
  implementing the affected feature. Never invent its contents.

## What Rota is

Rota is a shift-scheduling mobile app for small teams such as restaurants, clinics and shops.
An owner creates a team, invites staff and publishes shifts; staff view shifts, request swaps and get notified.
Teams pay a monthly per-seat subscription, with proration calculated by our own server code.
Roles: **Owner** (team, billing, full control) · **Manager** (create/edit shifts, approve swaps) · **Staff** (view shifts, request swaps, own preferences).

## How to work with Dave

1. **Plan first.** Before code: the problem, the options, your recommendation and why, files touched. Wait for "go".
2. **Plain words first, jargon second**, for every new concept.
3. **One slice at a time**, verified, then stop.
4. **Never invent a number**, version, config value or price. Say you don't know and check.
5. **Tell him when he's wrong**, or when a request would fail a requirement or a reviewer.

## Stack

Substituting anything requires asking first. **The purchased domain and its annual renewal are a separate
expense. All additional application infrastructure must remain on free plans without paid upgrades or
expiring trial credits. If something can't be free, say so plainly.**

- App: React Native + Expo, TypeScript. Android EAS **development build** (Expo Go can't receive push).
- App state: TanStack Query for all server state. Client state tool: **pending** (Dave picks, justified in `STATE.md`).
- Tokens: `expo-secure-store` only.
- API: Node.js + Express + TypeScript. Validation: Zod on the **whole request** (body, query, route params).
- Database: PostgreSQL on two Neon projects (one per shard), pooled `-pooler` strings, read replicas.
- ORM: Prisma 7 with `@prisma/adapter-pg`. Deployment provider: **pending approval** (Northflank candidate, Oracle Always Free fallback).
- Queue, cache, rate limits: BullMQ on **one Aiven for Valkey instance**. Valkey is a substitution for the
  Redis the brief names. It must be recorded in `ARCHITECTURE.md` and an ADR. Facilitator sign-off pending.
- Payments: Stripe **test mode**, Checkout in payment mode or a PaymentIntent. **No Stripe Subscriptions.**
- Email: Resend HTTP API, sent from a background job only. Sender: `Rota <notification@rota.davebuilds.design>`.
  Reply-To: `rota@davebuilds.design`. Server env vars: `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO`.
  Sending-domain verification and incoming forwarding are complete; outgoing application delivery remains untested.
- Sentry on app and server. k6 for load tests.

## Hard rules — absolute, no exceptions

1. **Store monetary amounts as integer minor units (cents).** Use exact arithmetic for proration and apply
   the specified rounding rule when producing monetary amounts. Never use floating-point arithmetic for money.
2. **No money logic of any kind in the mobile app.** The app never calculates, derives or decides anything
   about money. It does no arithmetic on amounts. It holds no table of plan prices or seat costs. It never
   computes a proration preview, subtotal, total, credit or tax. It never decides whether a payment succeeded.
   Every figure the app shows, including "you'll be charged X today", comes from a server response; the app
   only formats it for display. If a screen needs a number, add a server endpoint that returns it.
3. **Every authorisation decision happens on the server.** Never trust a user ID, role, team, amount or
   payment status sent by the client. Every query is scoped to the caller's team.
4. **Tokens live in `expo-secure-store`. Never AsyncStorage**, which is unencrypted.
5. **No secrets in the repo or the app bundle.** Secrets are server env vars, with names (no values) in
   `.env.example`. Anything `EXPO_PUBLIC_` is readable by anyone who downloads the app.
6. **We calculate proration, never a provider.** Plan, seats, period start and period end live in our
   database. Stripe only collects an amount we already calculated.
7. **Only a verified webhook decides a payment's outcome.** Mount `express.raw({ type: 'application/json' })`
   on the webhook route only, registered before any global `express.json()`. The webhook request verifies the
   Stripe signature against the raw, unparsed body, then durably records the event in Postgres (deduplicated
   by event ID), then acknowledges. All business processing after that is queued.
8. **Ledger rows are append-only.** Never `UPDATE` or `DELETE` one; corrections are new rows.
   Subscription state must be rebuildable from the ledger.
9. **PostgreSQL first, then the queue.** Record webhook events, renewals and required emails in Postgres
   before enqueueing. The Valkey queue can lose jobs; reconciliation re-enqueues unprocessed rows
   (see `jobs.md`).
10. **Work that isn't needed to answer the request runs as a background job**: push, email, webhook business
    processing, renewals. The one synchronous provider call is payment-session creation: the endpoint makes a
    bounded Stripe call (timeout, idempotency key) and returns the session. It never records a payment outcome.
11. **Never cache** active subscriptions, payment status, credit balances or webhook idempotency records.
    Every cached item gets a TTL.
12. **Rate limits live in Valkey, never in memory.** Never change Valkey's `noeviction` policy.
13. **Write failures are possible.** With `noeviction`, Valkey can reject writes when memory is full, so
    handle that case. A cache failure must never block recording a billing event in Postgres.

## Stop and ask before

- Changing the stack, or adding any dependency with a native module (it forces a new EAS build).
- Altering the schema once data exists, or deleting or rewriting a migration.
- Touching anything in the payment or ledger path.
- Implementing renewals: first explain the test-mode collection flow, including saved-payment-method consent
  and any customer action required.
- Relaxing a security rule to make a test pass.
- Choosing the deployment provider or the client state tool.

## Never

- Commit credentials or secret values. If suspected secret material is found, stop, identify it without
  exposing its value, and remove it from the proposed commit.
- Use floating-point arithmetic for money, or do any money arithmetic in `app/`.
- Follow a Stripe Subscriptions or quantity-change tutorial.
- Send push or email inside a request handler.
- Describe the payment integration as production-ready. The wording is: "This integration uses Stripe test
  mode only. Live-payment eligibility has not been verified."

## Always-on reminders

- **A real bug appears?** Tell Dave to record it broken *before* fixing it, then again after.
- **First touch of a self-study topic?** Name it and prompt his own-words `LEARNING-LOG.md` entry. The topics
  are EAS Build, AsyncStorage risk, refresh rotation and reuse, idempotency, observability, load testing, ADRs.
- **Slice finished, or Dave says he's stopping?** Prompt his `LEARNING-LOG.md` paragraph (never write it for
  him) and remind him to log today's building minutes in his daily log.
- **About to propose something that needs a native rebuild?** Warn first. Builds are on a limited
  low-priority monthly quota.
- **Three features without a PR?** Say so.
- **A Rota feature now maps to a type of company?** Add it to `docs/outreach-feature-map.md`.

## Definition of done (every slice)

1. It works on a real device or against a real request.
2. Evidence is in the PR description: the exact SQL query, Postman request or test command that shows the right row exists.
3. Required tests pass.
4. Docs are updated in the same PR.
5. An ADR exists in `docs/decisions/` if a real decision was made.
6. Dave has been prompted for his own-words `LEARNING-LOG.md` paragraph.
7. You asked the matching interview question from the spec and said whether his answer would survive.

## Infrastructure gate — before any feature work

Proven locally: API and worker running on Dave's machine against the real cloud services. Until every box
passes, the infrastructure is a plan, not a verified stack:
- [ ] Both requirement sources opened and read
- [ ] API and worker start locally
- [ ] Both Neon shards connected
- [ ] A `Queue.add` consumed by a `Worker` on Aiven Valkey
- [ ] Delayed job and retry
- [ ] Worker-restart recovery
- [ ] Neon, Aiven and Resend confirmed free; spending blocked, not just alerted

## Later proofs (not blocking)

These stay required before submission but no longer hold up feature work. The reconciliation sweep that
queue-loss recovery depends on already exists (ADR 0004); only its end-to-end proof is deferred.
- [ ] Queue-loss recovery: delete disposable queued jobs from Valkey; the independent reconciliation
      process restores them from Postgres. A worker restart alone doesn't prove this.
- [ ] Queue-loss recovery repeated with the deployed worker
- [ ] One email from the worker through Resend. Proven with the invite feature.
- [ ] Password blocklist data: bundle a list of common/compromised passwords whose data licence is confirmed (or write our
      own), with its source and licence notice. The mechanism exists but the list is empty, so NIST SP 800-63B-4 3.1.1.2's
      blocklist SHALL is not yet met (ADR 0005).

## Deployment gate — before read-your-own-writes is marked done, and before submission

Feature work may continue locally while this is open. Nothing is described as deployed until it passes:
- [ ] Provider approved by Dave and recorded in an ADR
- [ ] Provider confirmed free; spending blocked, not just alerted
- [ ] API and worker running on the approved provider
- [ ] Stop-then-start deploys confirmed: the old API process stops before the new one starts (`data.md`,
      one-process rule). If the provider can't do this, stop and ask; the read-your-own-writes design changes.
- [ ] Worker-restart recovery repeated with the deployed worker
- [ ] One email from the deployed worker through Resend

## Repo map

```
app/                 Expo app (+ app/AGENTS.md)       server/        Express API, worker, DB (+ server/AGENTS.md)
docs/                ARCHITECTURE, STATE, SECURITY, SHARDING, decisions/, outreach-feature-map.md
docs/requirements/   ROTA-BUILD-PROMPT.md
load-tests/          k6 scripts + written report       .agents/       rules/ and skills/ (canonical)
.claude/skills/      symlinks to .agents/skills/       root           README, LEARNING-LOG, .env.example, LICENSE
```

## Commands

Server commands run from `server/`. Node 24 (`.nvmrc` at the root). Local values go in a root `.env`, copied
from `.env.example` (names only); the server scripts read it.

| Task | Command |
|---|---|
| Install | `cd server && npm ci` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Run API (compiled; build first) | `npm run start:api` |
| Run worker (compiled; build first) | `npm run start:worker` |
| Run API / worker with reload | `npm run dev:api` / `npm run dev:worker` |

**Pending until a slice creates them.** Don't invent scripts: run app, migrate, seed, test, lint, load test.

The Android development build (`eas build`, profile pending) **needs a new native build. Warn first.**

## Read before working on…

Rules (`.agents/rules/`):
- `security.md` — auth, permissions, team isolation, Zod, rate limits, `EXPO_PUBLIC_` audit, secret scan
- `money.md` — anything touching prices, proration, Stripe, the ledger, renewals or webhooks
- `data.md` — schema, migrations, shard routing, pooling, read/write split
- `caching.md` — anything you'd store in Valkey besides jobs
- `jobs.md` — BullMQ, retries, the failed list, reconciliation, push, email
- `app-state.md` — TanStack Query, optimistic updates, offline shifts, `STATE.md`
- `observability.md` — logging, request IDs, Sentry
- `git-and-process.md` — branches, commits, PRs, ADRs, issues, README
- `release-gates.md` — repo settings, README first screen, release checks
- `evidence-capture.md` — bug recordings, the demo video, the outreach map
- `self-study-and-log.md` — self-study write-ups and the daily log
- `expo-builds.md` — anything native, push setup, or EAS

Skills (`.agents/skills/`):
- `add-api-endpoint` — every new endpoint
- `money-and-proration` — any charge calculation
- `cursor-pagination` — the activity feed
- `webhook-handler` — Stripe events
- `background-job` — any new job
- `shard-routing` — any new query
- `optimistic-update` — swaps and settings
- `auth-tokens` — login, refresh, logout
- `ship-feature-pr` — finishing a feature
- `load-test` — k6 runs and reports