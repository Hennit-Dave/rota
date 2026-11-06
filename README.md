# Rota

Rota is a shift-scheduling mobile app for small teams such as restaurants, clinics and shops: an owner
creates a team, invites staff and publishes shifts; staff see their shifts, request swaps and get notified.

**GIF of the app running:** pending — not yet recorded.

**Android development build:** [download the preview build](https://expo.dev/accounts/hennitdave/projects/rota/builds/a7d7a16c-6699-493a-b139-c7ce640d1c9f)
(public EAS build page, no sign-in needed — Install button). Tested on a real device and an emulator
against the live API: sign-in, push notifications (including a cold start), invite links (including a
cold start, App Links verified), theme switching.

**Demo video:** pending — not yet recorded.

**Live API:** `https://api.rota.davebuilds.design` (`GET /health` returns `{"ok":true}`; deployed on
Northflank, ADR 0040).

This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

**Stack:** React Native + Expo (TypeScript, Android) · Node.js + Express + TypeScript · PostgreSQL on two
Neon shards, Prisma 7 · BullMQ on Aiven Valkey (queue, cache, rate limits) · Stripe test mode · Resend ·
Sentry · deployed on Northflank.

**Docs:** [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) ·
[Sharding](docs/SHARDING.md) · [App state](docs/STATE.md) · [Decisions (ADRs)](docs/decisions/) ·
[k6 load test report](load-tests/REPORT.md)

Design: [Rota screens in Figma](https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY)

## The problem

A small team — a café, a clinic, a shop — runs its rota out of a group chat and a shared spreadsheet.
Shifts get posted as a photo of a whiteboard. A swap gets agreed in the chat and someone forgets to tell
the manager, so two people show up for one shift and nobody does the other. A change happens at 11pm and
whoever's phone is on buzzes, whether it's urgent to them or not. None of it is wrong exactly, it's just
manual: every rule ("has the manager approved this swap?", "is this person even still on the team?",
"did billing actually go through this month?") lives in someone's head instead of being enforced
anywhere. Rota moves those rules onto a server that enforces them on every request, not just in the UI.

## Tech stack, and why

| Layer | Choice | Why |
|---|---|---|
| Mobile app | React Native + Expo, TypeScript, Android | One codebase, EAS Build for native builds without owning build infrastructure; Android only because an iOS device build needs a paid Apple Developer account |
| Server state | TanStack Query | Cache times, retries and refetch-on-foreground come for free, documented per-query in `STATE.md` |
| Client state | Zustand | One small store for session status, selected team and UI flags — explained in [ADR 0008](docs/decisions/0008-client-state-zustand.md) |
| Tokens | `expo-secure-store` | Encrypted, excluded from Android's own backup — AsyncStorage is unencrypted |
| API | Node.js + Express + TypeScript | Whole-request Zod validation (body, query and route params) on every route |
| Database | PostgreSQL on two Neon projects (shards), Prisma 7 | Sharding is simulated per the brief, hashed by `team_id` — [SHARDING.md](docs/SHARDING.md) |
| Queue, cache, rate limits | BullMQ on Aiven Valkey | A substitution for the brief's Redis — [ADR 0003](docs/decisions/0003-queue-worker-and-recovery.md) |
| Payments | Stripe, test mode only | Checkout/PaymentIntent, never Stripe Subscriptions — proration is ours, calculated on the server |
| Email | Resend | Sent only from a background job, never inside a request |
| Deployment | Northflank | [ADR 0040](docs/decisions/0040-northflank-deployment.md) — free plan, no payment method charged |
| Errors | Sentry (EU) | Errors only, one shared redaction list between server and app — [ADR 0039](docs/decisions/0039-sentry.md) |

## How to run it locally

Covered in full below: ["Run the server locally"](#run-the-server-locally) and ["Run the app"](#run-the-app-android-development-build).
Short version: `cd server && npm ci && npm run build` then `npm run start:api` / `npm run start:worker`
(needs a root `.env`, copied from `.env.example`), and the Expo app against either your own local API or
the deployed one at `https://api.rota.davebuilds.design`.

## Architecture summary

App, API and worker are three separate processes; the API and worker share one Docker image (different
start commands, [ADR 0036](docs/decisions/0036-container-image.md)) and both run on Northflank. Data is
split across two independent Postgres databases ("shards"), each team routed to one by a hash of its ID,
with a read replica per shard for read-heavy endpoints. One Valkey instance is the queue, the cache and
the rate limiter. The Stripe webhook, email and push notifications all go through the queue — nothing
slow or unreliable runs inside a request. Full diagram and detail: [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Key decisions

- **Valkey instead of Redis** ([ADR 0003](docs/decisions/0003-queue-worker-and-recovery.md)): an
  open-source, API-compatible fork, after Redis's own license change — Aiven offers it free with no card.
- **We calculate proration, never Stripe** ([ARCHITECTURE.md §5h](docs/ARCHITECTURE.md)): plan, seats and
  period live in our own database so the exact brief's rounding rule is testable in isolation, with no
  Stripe Subscriptions object standing between us and what a customer is actually charged.
- **Sharding by `team_id`, not by user** ([SHARDING.md](docs/SHARDING.md)): keeps one team's data on one
  database so its own dashboard needs one query, not a fan-out — at the cost of a hot shard if one team
  ever gets very large, a trade-off written down rather than hidden.
- **Deploying through Northflank mid-build, after a real security incident on the provider**
  ([ADR 0040](docs/decisions/0040-northflank-deployment.md)): the account held no secrets yet when it
  happened, so the risk was accepted with every deploy credential made new, least-privilege where
  possible, and separately rotatable from local dev — rather than treated as a reason to stall the whole
  deployment gate.

## What I'd do next

In rough priority order, all written down as they were found rather than discovered now:

1. **Make read-your-own-writes and the team cache safe for more than one API instance.** Both currently
   rely on one process's in-memory 5-second marker; running two instances needs a position-based design
   instead (comparing replica replay position to the write's commit LSN) — [ARCHITECTURE.md, "What
   changes in production"](docs/ARCHITECTURE.md).
2. **Measure the k6 load test's database time and pool wait separately**, not just whole-request latency
   — [issue #83](https://github.com/Hennit-Dave/rota/issues/83).
3. **Turn on Expo's enhanced push security** (an unauthenticated send endpoint today) and add a TTL to
   billing push notifications — [ADR 0032](docs/decisions/0032-push-notifications-part-1.md).
4. **Fill in the password blocklist** NIST SP 800-63B-4 asks for — the mechanism exists, the list is
   empty, pending a data source with a confirmed licence — [ADR 0005](docs/decisions/0005-authentication-tokens-and-sessions.md).
5. **A narrower Neon role for the deploy credential** (it currently has full project access because
   Neon's Console offers nothing narrower) — [ADR 0040](docs/decisions/0040-northflank-deployment.md).
6. **Queue clustering** (Valkey HA/Sentinel) once a single node's periodic-snapshot durability stops
   being enough — Postgres stays the source of truth either way.

## In-app purchase rules, and why this app doesn't use them

*Checked 2026-11-06 against Apple's and Google's own current policy pages (quoted below, not from
memory). Both platforms' rules are moving targets — ongoing antitrust litigation has already changed
them once and a further revision is pending (see Google, below) — so this is a snapshot, not a
permanent answer; re-check before ever relying on it.*

Apple and Google each require their own purchase system for most subscriptions bought inside a mobile
app — this section exists because I'm not publishing Rota to either store, and the README should show I
know why that would matter if I did.

**Apple (App Store Review Guidelines).** Section 3.1.1 is the default — "If you want to unlock features
or functionality within your app... you must use in-app purchase," and 3.1.2(a) names software-as-a-service
explicitly as a subscription type this covers. The one plausible exception is **3.1.3(c), Enterprise
Services:** "If your app is only sold directly by you to organizations or groups for their employees or
students... you may allow enterprise users to access previously-purchased content or subscriptions.
Consumer, single-user, or family sales must use in-app purchase." A team subscription sold directly to a
business could plausibly fit that — but Apple decides case by case, and a single-owner sign-up through
the app itself looks a lot like the "single-user" case the same sentence excludes. There is no general
"it's B2B so it's exempt" rule. **US storefront carve-out (post-*Epic v. Apple*):** 3.1.1(a) states the
external-purchase-link entitlement is "not required... to include buttons, external links, or other
calls to action in their United States storefront apps" — elsewhere, "this prohibition does not apply"
only to the US. So a US release could link out to a web checkout without Apple's IAP at all, as an
alternative to the enterprise exception above. Apple's own page did not state a current commission
figure for such external-link sales where I could confirm it, so none is given here rather than guessed.

**Google (Play's Payments policy).** Google Play's own billing system is required for "in-app purchases,"
and its own examples name "business productivity software" directly — so Rota's per-seat plan would not
obviously qualify for the physical-goods-and-services exceptions (transportation, cleaning, gym
memberships, event tickets — real-world services consumed outside the app), the way, say, a taxi app's
fare does. **US allowance (post-*Epic v. Google*):** Google's own page confirms it is still in effect today —
"Google will not require the use of Google Play Billing in apps distributed on the Google Play Store, or
prohibit the use of in-app payment methods other than Google Play Billing" for US users — but it is an
**opt-in program requiring enrollment**, not an automatic exemption, and Google still takes a service fee
on the alternative-billing transaction: **10% for the first $1M of annual earnings and for recurring
transactions completed through an alternative billing system**, per Google's own current fee table. A
revised settlement was filed with the court on 4 March 2026 and a new injunction is pending as of
Google's most recent update (21 October 2026) — the rule as stated here could change again.

**What this would mean in practice if Rota shipped to the stores:** either plan pricing, seat changes and
renewals would need to move onto Apple's and Google's own subscription products — losing the exact
proration engine this build was graded on, since both platforms own the subscription lifecycle, pricing
tiers and renewal timing themselves — or the app would need to qualify for, and enrol in, one of the
exceptions above (Apple's enterprise exception or US external link; Google's US alternative-billing
program, still paying Google a reduced fee). Either path is a real decision to make before a store
release, not a technicality. As shipped, none of this applies: Stripe runs in **test mode only**, and the
app is not submitted to either store.

## Run the server locally

Needs Node 24 (`nvm use` reads `.nvmrc`) and npm. The API and worker processes exist, along with the database
and queue foundation: Prisma, two Neon shards, shard routing, pooled per-shard clients, and the BullMQ
background job worker running on Aiven Valkey. Features come later.

```sh
cd server
npm ci
npm run db:generate    # generates the Prisma client into src/generated/ (gitignored, so a fresh clone has none)
npm run build
npm run typecheck
npm test              # runs unit tests (no database, no network)
npm run test:integration # runs database integration tests (needs .env, guards against non-test DB); also test:integration:slow and test:all, see below
npm run start:api      # terminal 1: http://localhost:3000/health returns {"ok":true}. Needs AUTH_JWT_SECRET, MAIL_FROM and MAIL_REPLY_TO (see below)
npm run start:worker   # terminal 2: logs "worker running". Needs RESEND_API_KEY (see "Invitations and email")
```

`db:generate` needs no `.env`, no database and no network: it reads only `prisma/schema.prisma`. The
`build`, `typecheck`, `test` and `dev:*` scripts run it first automatically, so it is safe to skip, but
`src/generated/` must exist before anything that imports the Prisma client compiles. Re-run it after any
schema change. The generated client is never committed.

### Database commands (need a root `.env`)

Copy `.env.example` to `.env` at the repo root and fill in the values. `.env` is gitignored. `PORT` is
optional and defaults to 3000. The API and worker start without the database values; the commands below
need them.

| Command | Needs | What it does |
|---|---|---|
| `npm run db:deploy:a` then `npm run db:deploy:b` | `SHARD_A_DIRECT_URL`, `SHARD_B_DIRECT_URL` | Applies migrations to shard A, then shard B. Run A first, check it, then B |
| `npm run db:status:a`, `npm run db:status:b` | the matching direct URL | Shows each shard's migration status |
| `npm run db:parity` | both direct URLs | Fails if the shards' applied migrations differ |
| `npm run db:check-pooled` | `SHARD_A_DATABASE_URL`, `SHARD_B_DATABASE_URL` | Checks both shards through the pooled `-pooler` URLs. A failure is reported, never retried on a direct URL |

Migrations use the direct (unpooled) URLs because Prisma's migration engine does not work through the pooler.
Runtime clients (`server/src/db/clients.ts`) use the pooled URLs. See `docs/decisions/0002-database-foundation.md`.

**Read replicas** (issue #15, ADR 0037): each Neon project has one read replica. The API needs `SHARD_A_READ_URL` and `SHARD_B_READ_URL` (the replica's
pooled host, same role and database as the primary) and refuses to start without them; `proof:api` and the replica tests need `TEST_SHARD_A_READ_URL` and
`TEST_SHARD_B_READ_URL`. The worker does not use them. Three reads are routed to the replica (the shift calendar, the activity feed, the roster); the
user who just wrote reads the primary for 5 seconds. Everything else reads the primary. Each request's log line carries `dbRoute`: `none` (replica),
`marker`, `startup`, `primary-required` or `replica-failed`. The replica sleeps after 5 minutes idle, so the first read after a quiet spell takes a
second or two longer.

**Team cache** (ADR 0038): the roster, the shift calendar and the first page of the activity feed are cached in Valkey (cache-aside, a TTL on every key, replaced after the
write commits). Optional env names are in `.env.example` (`CACHE_ENABLED` and the `CACHE_TTL_*` values). **`CACHE_ENABLED=false` is the one switch:** nothing is read from or written to
the cache, which is how the k6 "before" run is made with the same build. Each request on those three endpoints logs `cache` (`hit`, `miss`, `bypass`, `off`, `error`) beside `dbRoute`,
and a `cache_stats` line every 60 seconds gives the counters and the hit rate. A cache failure is logged once and the request is answered from the database. Billing, payment status,
sessions, permissions and idempotency records are never cached; `server/src/cache/writeSites.unit.test.ts` fails if a new writer of cached data forgets to replace the cache generation.

**Sentry** (ADR 0039): errors only, on the API, the worker and the app, into two EU Sentry projects. `SENTRY_DSN` (the root `.env`, and the deployed API and worker) and `EXPO_PUBLIC_SENTRY_DSN` (`app/.env`, because Expo
only reads the app's own `.env`) switch it on; with neither, nothing is sent. Both packages strip secrets, emails, card and payment data and `Authorization` headers with **one shared list** (`shared/sentry-scrub.ts`, copied into each package by
`node shared/sync-sentry-scrub.mjs`; a test fails if a copy differs) and limit what leaves (one event per error per 5 minutes, 50 a day per server process, 20 per app session). `npm run sentry:test-event` (from `server/`) sends one test event; the app's is the "Send Sentry test event" button on the development check screen (`rota:///dev-check`, development builds only). Every event carries the placeholder address `0.0.0.0`, so Sentry cannot infer a user's city and country from the connection's IP (ADR 0039). `X-Load-Test: k6` is honoured only while `LOAD_TEST_MODE=true`, set for the k6 run and at no other time.
The server runs with `node --enable-source-maps` so stack traces name TypeScript files.

### Container image (issue #14, ADR 0036)

One image runs both programs. The build context is `server/`:

```
docker build -t rota-server server
docker run --rm -p 3000:3000 --env-file .env rota-server                  # the API (default)
docker run --rm --env-file .env rota-server node --enable-source-maps dist/worker/main.js   # the worker
curl localhost:3000/health                                                # {"ok":true}
```

The image holds no secrets and no `.env` file; settings arrive as environment variables (names in `.env.example`). It does
not run migrations: those stay `npm run db:deploy:a` then `db:deploy:b`, from a developer machine. Add `-e
USE_TEST_SHARDS=true -e WORK_QUEUE_NAME=work-proof` to run it on the test shards, as `proof:api` does.

GitHub Actions (`.github/workflows/docker.yml`) builds the image on every change under `server/`, starts the API with placeholder
values (no secret, no real service), calls `/health`, checks that `docker stop` ends it with exit code 0 and that it runs as a non-root
user, and checks that the worker command starts from the same image. Nothing is pushed anywhere.

### Queue and worker commands (need `VALKEY_URL` in `.env`)

Valkey on Aiven is used for background queuing (`docs/ARCHITECTURE.md`, `docs/decisions/0003-queue-worker-and-recovery.md`).
The service must have `maxmemory-policy: noeviction`.

| Command | Needs | What it does |
|---|---|---|
| `npm run jobs:check-valkey` | `VALKEY_URL` | Connects to Valkey, verifies `noeviction` policy, reports status |
| `npm run jobs:prove:boxes-4-5` | `VALKEY_URL`, `SHARD_A_DATABASE_URL`, `SHARD_B_DATABASE_URL` | Proves Box 4 (immediate execution on Shards A & B with timing) and Box 5 (delayed fire strictly at/after run_at, exponential backoff) |
| `npm run jobs:prove:crash` | `VALKEY_URL`, `SHARD_A_DATABASE_URL` | Proves Box 6 (abrupt SIGKILL termination mid-claim and recovery upon lease expiry) |

### Invitations and email (server; needs `MAIL_FROM`, `MAIL_REPLY_TO` for the API and `RESEND_API_KEY` for the worker)

An Owner or Manager invites someone by email into a role. The API writes the invitation and its email work row together, and the **worker** sends the
email through Resend (never the request). Both processes refuse to start without their mail settings: `MAIL_FROM` (`Rota <notification@rota.davebuilds.design>`)
and `MAIL_REPLY_TO` (`rota@davebuilds.design`) for the API, and `RESEND_API_KEY` (a secret, worker only) for the worker. Names are in `.env.example`.
Optional: `INVITE_EXPIRY_DAYS` (7), `INVITE_GLOBAL_DAILY_CAP` (50 invite emails per UTC day: Resend's free plan sends 100 a day in total),
`INVITE_LINK_BASE_URL` (`https://rota.davebuilds.design`). Tests use a fake Resend and never send real mail. Decisions: `docs/decisions/0015-invitations.md`,
`docs/decisions/0016-email-sending-job.md`. The link only opens the app once `rota.davebuilds.design` is live on GitHub Pages and Android has verified it (issue #35, ADR 0019).

### Authentication (server only; needs `AUTH_JWT_SECRET`, `VALKEY_URL` and the shard URLs in `.env`)

Email-and-password sign-up with short-lived access tokens, rotating refresh tokens and logout. The API refuses to start
without a signing secret. Routes, error codes and limits: `docs/ARCHITECTURE.md` (section 5) and `docs/SECURITY.md`.

Sign-in: email and password, plus magic link (the brief's alternative to Google sign-in).

**Password reset and magic link** (slice 2b, ADR 0020): `POST /auth/password-reset/request` and `/submit`, `POST /auth/magic-link/request` and `/redeem`. A request is
answered the same for every address and emails a single-use link (a reset lasts 1 hour, a magic link 10 minutes) through the same email job as invitations, so the
**worker must be running** (`RESEND_API_KEY`) for the email to go out. The app opens the links at `/reset/<token>` and `/magic/<token>`. New table `auth_tokens`
(migration `20261026140000_add_auth_tokens`): run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/` before using a real shard.

**Shifts and the calendar** (slice C1, ADR 0021): `GET/POST /teams/:teamId/shifts` and `GET/PATCH/DELETE /teams/:teamId/shifts/:shiftId`. An Owner or Manager publishes, edits and deletes
shifts; everyone in the team can read them; one person cannot be booked twice at the same time (`409`). New tables `shifts` and `activity` (migration
`20261026160000_add_shifts_and_activity`): run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard.
Optional: `SHIFTS_MAX_RANGE_DAYS` (42). The app's home is now the Schedule, with a bottom bar (Schedule, Team, Settings).

**Activity feed** (slice C2, ADR 0022): `GET /teams/:teamId/activity?limit&cursor` returns what happened to the team's shifts, newest first, a page at a time by cursor (20 rows by default, 50 at most), limited to 120 requests a minute per user, and answering `503` when Valkey is down. New migration `20261027120000_add_activity_feed_index`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `ACTIVITY_PAGE_DEFAULT`, `ACTIVITY_PAGE_MAX`, `RATE_LIMIT_FEED_USER_MAX` / `_WINDOW_SECONDS`. `npm run db:feed-proof -- seed | explain | clean` (test shards only) seeds 10,000 feed rows and prints the query plan. In the app, "View activity" on the Schedule opens it.

**Shift swaps** (slice S1, ADR 0023): `GET/POST /teams/:teamId/swaps` and `/:swapId`, `/:swapId/cancel`, `/:swapId/approve`, `/:swapId/reject`. Staff ask to exchange one of their upcoming shifts for a teammate's; an Owner or Manager approves or rejects (never someone who is part of the swap, unless they are the Owner and the only approver). A retried request (same `Idempotency-Key`) never creates a second one; at most 3 requests wait per person and 10 may be made per hour. Two new migrations, `20261028100000_add_swap_activity_kinds` and `20261028110000_add_swap_requests`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `SWAPS_MAX_PENDING`, `RATE_LIMIT_SWAP_REQUEST_USER_MAX` / `_WINDOW_SECONDS`. In the app: the Swaps tab.

**Invite links** (issue #37, ADR 0025): `POST /teams/:teamId/invitations/links` makes a single-use link, not tied to an email address, that an Owner or Manager can share (Staff only, 48 hours, at most 10 pending per team); the same `DELETE` revokes it, and the existing preview and accept routes use it. One migration, `20261028170000_add_invitation_links`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `INVITE_LINK_EXPIRY_HOURS`, `INVITE_LINK_MAX_PENDING`, `RATE_LIMIT_INVITE_LINK_USER_MAX` / `_WINDOW_SECONDS`, `RATE_LIMIT_INVITE_LINK_TEAM_MAX` / `_WINDOW_SECONDS`. In the app: "Create an invite link" on the invite form (Copy or Share), and link rows in the pending list.

**Settings** (slice S2, ADR 0024): `GET` and `PATCH /settings`. The server is the single source of truth for quiet hours, time zone, notification types (shift changes, swap updates, billing), language (`en` only) and theme; each setting has its own server-set `updatedAt` and the most recent change wins (the weakness is in `docs/STATE.md`). One migration, `20261028150000_add_user_settings`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `RATE_LIMIT_SETTINGS_READ_USER_MAX` / `_WINDOW_SECONDS`, `RATE_LIMIT_SETTINGS_WRITE_USER_MAX` / `_WINDOW_SECONDS`. In the app: the Settings tab (the sign-out buttons are under "Account & sessions"), and the theme setting now colours every signed-in screen. Quiet hours are stored but not yet enforced: that arrives with push notifications.

**Billing engine and schema** (slices P1 + P2, ADR 0026): no endpoint yet. `server/src/billing/` is the pure proration engine (integer cents, the brief's example is 2000; a charge under Stripe's 50-cent minimum is applied free) and the ledger functions; one migration, `20261028190000_add_billing`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Unit tests: `npm test`; schema tests against the TEST shards: `node --env-file-if-exists=../.env --import tsx --test --test-concurrency=1 src/billing/billing-schema.integration.test.ts`. This integration uses Stripe test mode only. Live-payment eligibility has not been verified. Stripe itself arrives with the next slice.

**Activation: Stripe Checkout, the webhook and seat limits** (slice P3, ADR 0027): an Owner picks a plan and seats in the app, the server calculates the first period's charge, freezes it, and opens Stripe Checkout; only a signature-verified webhook, processed in a background job, activates the team. No schema change. Set `STRIPE_SECRET_KEY` (**must start with `sk_test_`**: the API refuses to start otherwise) and `STRIPE_WEBHOOK_SECRET` (the `whsec_` secret that `stripe listen` prints) in the root `.env`; names only are in `.env.example`. Locally: install the Stripe CLI, `stripe login`, then `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired --forward-to localhost:3100/webhooks/stripe (the API port: set `PORT=3100` in the root `.env`, which is also where `app/.env` points)` while the API and the worker run. Tests: `npm test` (unit), and against the TEST shards `node --env-file-if-exists=../.env --import tsx --test --test-concurrency=1 src/billing/activation.integration.test.ts src/billing/seats.integration.test.ts`. For a manual proof (the app, the Stripe CLI, the SQL) run `npm run proof:api` and `npm run proof:worker` from `server/` (after `npm run build`): they use the TEST shards and their own queue; the plain `start:*` scripts use the real shards. A team on Starter (or not yet activated) holds five seats; the server refuses the sixth. This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

**Plan and seat changes and billing history** (slice P4, ADR 0028): an active team's Owner can add seats or move to a higher plan from "Plan & billing" in the app. The server quotes the change with the proration engine (`GET /teams/:id/billing/change-quote`), a change that costs nothing applies at once, and a paid one goes through Stripe Checkout and is applied only by the verified webhook, against the subscription version it was quoted against. Reductions arrive with the next slice. No schema change. Tests against the TEST shards: `node --env-file-if-exists=../.env --import tsx --test --test-concurrency=1 src/billing/changes.integration.test.ts`. To prove a paid change against Stripe's sandbox on any day, `npm run proof:seed-subscription -- <teamId> team 15 12` (TEST shards only) gives a team a Team plan with 15 seats and 12 days left in a 30-day period; Team 15 to 18 is then $3.60. This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

**Reductions at the end of the period** (slice P5, ADR 0029): an Owner can schedule fewer seats or a cheaper plan for the end of the current period and choose exactly which people become inactive (never the Owner). Nothing is charged or refunded now, new invitations must fit the future limit, and a background job re-checks the team at the period end and records `ready`, `continuing` (the Owner accepted keeping the current price) or `blocked`. It applies nothing yet: applying a reduction is the renewal slice. A deactivated member is a non-member on every route and does not use a seat. **Schema change:** `memberships.deactivated_at` and `scheduled_changes` (migration `20261030140000_add_scheduled_changes_and_deactivation`, applied to the TEST shards; the real shards need `db:deploy:a`, `db:deploy:b`, then `db:parity`, on Dave's go). Tests against the TEST shards: `node --env-file-if-exists=../.env --import tsx --test --test-concurrency=1 src/billing/reductions.integration.test.ts`. Limits: a change that adds and reduces at once is not offered (make the increase first); the Owner's push and email notice waits for the push slice (#53). This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

**A saved card and the consent to charge it** (slice P6a, ADR 0030): activation now also saves the card (Stripe Checkout asked to keep it for later charges, with the consent wording beside the pay button), and an active team's Owner can add, replace or remove a card from "Plan & billing" (Checkout in setup mode: nothing is charged). The consent text is made on the server from the team's own price, shown in the app and on Stripe's page, and stored with the card; a card is recorded only after a verified webhook and a read-back from Stripe, and a card problem never undoes a payment. The app never sees a Stripe id. Additive migration `20261101100000_add_saved_card_and_consent` (both shards). The worker now also needs `STRIPE_SECRET_KEY` (it only reads from Stripe). This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

**Renewals and failed renewals** (slice P6b, ADR 0031): when a period ends the worker charges the saved card for the next one (our engine's amount, a PaymentIntent with a key that is stable per attempt) and **only the verified webhook** applies it: next period, ledger rows, subscription, and the next renewal. A scheduled reduction is applied first. A failed renewal starts a grace period (`RENEWAL_GRACE_DAYS`, default 7), emails the Owner (push waits for the push slice) and shows a banner; after the grace period every non-billing write (shifts, swaps, invitations) is refused with `team_read_only` until the Owner fixes the card and presses **Retry payment** and the payment is confirmed. Reads, sign-in and billing keep working. Additive migration `20261101200000_add_renewals` (both shards). The worker now also needs `MAIL_FROM` and `MAIL_REPLY_TO`, and `stripe listen` must forward `payment_intent.succeeded` and `payment_intent.payment_failed`. This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

**Push notifications, part 1** (ADR 0032, issue #53): a failed renewal now also pushes the Owner's phone, and only the Owner's. The server decides who is told, when and whether (role, per-type switch, the person's quiet hours and time zone, read when the job runs and rescheduled in the same transaction when they change); a background job sends through Expo's push service; dead phones are removed from Expo's receipts; tapping the notification opens the billing screen. No native build and no dependency change. To try it on the emulator (test shards, local Valkey, as for the Swaps tab): `npm run proof:seed-push` makes an Owner and a team, sign in on the phone, then `npm run proof:seed-subscription -- <teamId> team 9 0` makes a renewal that is due; the team has no saved card, so it fails at once and the push arrives. The phone needs Google Play services (a cold-booted, up-to-date emulator image); the Firebase service-account key is uploaded to Expo, never to the repo. Tapping a notification with the app closed needs a preview build to verify (ADR 0032).

**Push notifications, part 2** (ADR 0033, issue #53): the same engine now tells people about their schedule. A shift made, moved or removed tells the person it is assigned to (and the one it was taken from); a swap request tells the people who can decide it and the person asked; an approval or rejection tells both people in it. Never the person who did it; an open shift tells nobody. The words are short and generic (no title, time or name) because a notification can be read on a locked phone. Each type has its **own Android channel** (Shift changes, Swap updates, Billing), so a person can mute one in the phone's settings, on top of the switches in Rota's settings. The event is written in the same transaction as the change, so a push is never sent for a change that rolled back and never lost for one that committed. No native build, no migration.

**Offline upcoming shifts** (ADR 0034, ADR 0035, brief Requirement 2): the schedule keeps the signed-in person's own upcoming shifts on the phone and shows them, read-only, when the phone is offline or the server cannot be reached, with a "Last updated" time from the server's own clock. New route `GET /teams/:teamId/shifts/upcoming` (every role; only the caller's own unfinished shifts starting within 42 days, plus the team's name and time zone and `asOf`). The app saves that one query, and nothing else, in `expo-sqlite` (plain, ADR 0010) through TanStack's persister; a copy older than 7 days (chosen, not measured) is deleted, every sign-out deletes it, and another person signing in deletes the previous person's. A server that answers with a refusal (401, 403, 404) is never covered by an old copy. Nothing is written or queued offline. Every query and mutation now fails at once offline (ADR 0035). No native build and no migration. To try it on the emulator (test shards): `npm run proof:api`, `npm run proof:seed-shifts` (a Staff member with three upcoming shifts and a colleague whose shift must not appear), sign in as that person, then `adb shell cmd connectivity airplane-mode enable`, `adb reverse tcp:8081 tcp:8081` (so Metro still reaches the phone) and cold-start the app with the dev-client URL `exp+rota://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081`.

```sh
openssl rand -base64 32   # copy the output into AUTH_JWT_SECRET in the root .env (at least 32 bytes once decoded)
cd server && npm run build && npm run start:api
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests only: no database, no network |
| `npm run test:integration` | Needs the `TEST_*` variables in `.env`. Runs against the **test** shards and real Valkey, one file at a time. The fast integration tests. `valkey-recovery.integration.test.ts` starts its **own disposable local Valkey** (never the shared one) and needs `valkey-server` on PATH, or `LOCAL_VALKEY_BIN` pointing at it (Homebrew: `/opt/homebrew/opt/valkey/bin/valkey-server`); without it the tests skip with a message. **Every file is wrapped by the work-row guard** (`server/src/testing/workRowGuard.ts`, issue #62): it removes the work rows the file's tests created and fails the file if the test shards hold more pending or claimed rows afterwards than before. Use one test process on the test shards at a time (a proof worker running against them meanwhile would have its rows removed too) |
| `npm run test:rows` | Prints how many pending and claimed work rows each **test** shard holds, by kind: the before-and-after check for the integration tests (both should print 0) |
| `npm run test:integration:slow` | The concurrency and revocation-race tests (`*.slow.test.ts`). They hold database locks on purpose and take minutes against Neon |
| `npm run test:all` | All three. **Run it before every PR** |
| `node --test site/site.test.mjs` (from the repo root) | Checks the link host files in `site/` (ADR 0019): `assetlinks.json` is present and matches the app, the pages stay static. The Pages workflow runs it before every deploy |

Try it (default port 3000). This writes to the database in `SHARD_A_DATABASE_URL`, which is the real shard A, so use an address you are happy to leave there:

```sh
curl -s -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada Example","email":"ada@example.com","password":"a-long-enough-passphrase"}'
# -> 201 { user, session: { accessToken, accessTokenExpiresAt, refreshToken } }
curl -s localhost:3000/auth/me -H "authorization: Bearer $ACCESS_TOKEN"
curl -s -X POST localhost:3000/auth/refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
curl -s -X POST localhost:3000/auth/logout -H "authorization: Bearer $ACCESS_TOKEN"
```

## Run the app (Android, development build)

Expo SDK 58, React Native 0.88, Android only. Remote push does not work in Expo Go, so the app runs as a **development build**
(a debug app that loads its JavaScript from your computer). Decisions and the 16 KB page-size audit: `docs/decisions/0011-*.md`.
Where each piece of data lives: `docs/STATE.md`.

```sh
cd app
npm ci
npm run typecheck
npm test                 # unit tests, no device (client, refresh, sign-out, config, EXPO_PUBLIC allowlist)
npx expo-doctor          # 20 checks, should all pass
```

**Local build on an emulator or phone (free, does not use an EAS build).** Needs an Android SDK (`ANDROID_HOME`, usually
`~/Library/Android/sdk`) and a JDK. Android Studio's bundled JDK (25 on 2026-10-21) built it with Gradle 9.4.1; EAS itself uses JDK 17.
The first build downloads Gradle and NDK 27.1.12297006, so allow time and about 3 GB.

```sh
cd app
echo 'EXPO_PUBLIC_API_URL=http://10.0.2.2:3100' > .env      # 10.0.2.2 = this computer, seen from the emulator
npx expo prebuild --platform android --no-install            # generates android/ (gitignored)
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=$HOME/Library/Android/sdk
cd android && ./gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a && ./gradlew --stop && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
npm start                                                    # Metro; then open the app (or: adb shell am start -d "exp+rota://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" design.davebuilds.rota)
```

Run the API on a free port in another terminal (`PORT=3100 npm run dev:api` in `server/`; the server's default 3000 may be taken by another
project). The first screen is the sign-in screen. After signing in, the Schedule opens; the development-only link to the API check is under Settings, then Account & sessions
(`/dev-api`: it calls `GET /health` and says "The API answered: ok."), and from there a link to a check of every native module
(`rota://dev-check`, also reachable directly by that link, signed in or not).

**Open an invite link on the emulator** (until `rota.davebuilds.design` is live and verified, issue #35, a tapped `https` link opens the browser, so the app is targeted directly; `-p` skips link verification):
`adb shell am start -W -a android.intent.action.VIEW -d "rota://invite/<teamId>.<secret>" -p design.davebuilds.rota` (or the `https://rota.davebuilds.design/invite/...` form). Opening it consumes nothing; only the Accept button does. The link is in the invite email, or, for a proof with the worker off, in the email work row's payload on the **test** shards. Never paste a link into a PR or a log.

**Android 17 and the local API.** A development build declares `ACCESS_LOCAL_NETWORK` (dev-client server discovery), and on Android 17 an
address such as `10.0.2.2` counts as the local network. If the "nearby devices" prompt was declined, requests to the local API hang with no
error. Allow it, or run `adb shell pm grant design.davebuilds.rota android.permission.ACCESS_LOCAL_NETWORK`. A release build does not declare it.

**Check 16 KB page-size support** (the emulator image is Android 17 with 16 KB pages; `adb shell getconf PAGE_SIZE` must print 16384):

```sh
python3 scripts/check-16kb.py android/app/build/outputs/apk/debug/app-debug.apk    # zipalign -c -P 16, then every 64-bit .so; ends "RESULT: PASS"
```

Run it on the EAS build's APK too, before installing it. It fails (exit 1) on any library that is not 16 KB aligned.

Push needs `app/google-services.json` (Firebase client config, gitignored; ask Dave for it, or download it from the Firebase console for the
Android app `design.davebuilds.rota`). EAS cloud builds get it from the EAS file variable `GOOGLE_SERVICES_JSON`. Without it the app builds and runs but cannot
register for push. See ADR 0011. Nothing else needs a secret: the only `EXPO_PUBLIC_` variable is the API address (`docs/SECURITY.md`).

## Commands

### Look at the Swaps tab on the emulator (test shards, local Valkey)

Needs a root `.env` with the `TEST_SHARD_*` URLs and `TEST_DATABASE_ALLOWED=true`, an installed development build (see above), and a running emulator.
Use one terminal for each of the first three steps. Nothing here touches a real shard or the shared Aiven Valkey.

```sh
# 1. A disposable local Valkey (the binary is not on PATH; see "Run the server locally")
mkdir -p /tmp/rota-valkey && cd /tmp/rota-valkey
/opt/homebrew/opt/valkey/bin/valkey-server --port 6392 --bind 127.0.0.1 --save "" --maxmemory-policy noeviction

# 2. The API, pointed at the TEST shards, on port 3100
cd server && npm run build
set -a; . ../.env; set +a
PORT=3100 VALKEY_URL=redis://127.0.0.1:6392 \
  SHARD_A_DATABASE_URL="$TEST_SHARD_A_DATABASE_URL" SHARD_A_DIRECT_URL="$TEST_SHARD_A_DIRECT_URL" \
  SHARD_B_DATABASE_URL="$TEST_SHARD_B_DATABASE_URL" SHARD_B_DIRECT_URL="$TEST_SHARD_B_DIRECT_URL" \
  node dist/api/main.js                      # http://127.0.0.1:3100/health returns {"ok":true}

# 3. Metro, in watch mode (CI mode does not serve edits)
cd app
EXPO_PUBLIC_API_URL=http://10.0.2.2:3100 npx expo start --dev-client --port 8081 --clear
```

```sh
# 4. Seed "The Olive Room": a manager, two staff and one pending swap. Prints the manager's email and password.
cd server
VALKEY_URL=redis://127.0.0.1:6392 npm run db:demo-swap

# 5. Open the app on the emulator, sign in with the printed email and password, then tap Swaps
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d "exp+rota://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" design.davebuilds.rota
```

Notes:
- Each seed run adds a new team and four users to the **test** shards (it never deletes them: `app.stop()` would delete the team). Remove them by hand when you no longer need them.
- If the app is already signed in as someone else, use Settings, then Account & sessions, then Log out first.
- When typing with `adb shell input text`, tap the field first and check it has focus. With no field focused, a double `r` in the text reloads the app (React Native's dev shortcut) and the rest of the text is lost.
- To use the API from the host instead of the emulator, replace `10.0.2.2` with `127.0.0.1`.

## Load testing (k6)

`load-tests/` holds the Task A load test: 200 virtual users loading the activity feed at once, run
against the **real, deployed** shards, never local or test ones. Full write-up, both runs' results and
the cache hit rate: [`load-tests/REPORT.md`](load-tests/REPORT.md).

```sh
# From the repo root. Needs K6_DEPLOY_AUTH_JWT_SECRET in .env (the deployed AUTH_JWT_SECRET, pasted in
# for the run only, never the local one - the seeded tokens must verify against the deployed API).
cd server && npx tsx --env-file-if-exists=../.env ../load-tests/seed-k6-team.ts   # seed 200 users + 10k activity rows
k6 run load-tests/feed-load-test.js                                              # the actual run
cd server && npx tsx ../load-tests/cleanup-k6-team.ts                            # delete everything the seed created
```

Notes:
- Seed fresh immediately before each run (`seed-k6-team.ts` prints the configured access-token
  lifetime, and tokens expire); clean up immediately after.
- Raise each Neon shard's read replica cap before a real run and lower it back afterward - never leave
  it raised (`load-tests/REPORT.md`'s Neon budget section has the actual CU-hours used).
