# Rota — Architecture

This document describes the high-level architecture of Rota, key infrastructure decisions, and substitutions.

## System overview

Rota is a shift-scheduling mobile app for small teams (restaurants, clinics, retail).

- **Mobile Client:** React Native + Expo (TypeScript), using TanStack Query for server state and `expo-secure-store` for token security. Android EAS development build.
- **Backend API:** Node 24, Express 5, TypeScript. Strict whole-request Zod validation. Single-process model with 5-second in-memory read-your-own-writes tracking.
- **Worker Process:** Separate Node process consuming background jobs via BullMQ with atomic lease ownership and execution tracking in PostgreSQL.
- **Database:** PostgreSQL on two Neon projects (one per shard), accessed via pooled `-pooler` connection strings for runtime queries and direct unpooled URLs for Prisma migrations.
- **Queue and Cache:** Valkey on Aiven (see substitution below).
- **Email:** Resend HTTP API, sent from background worker jobs only.
- **Payments:** Stripe test mode, Checkout/PaymentIntent in payment mode. No Stripe Subscriptions; our server calculates proration.

---

## Infrastructure substitutions and choices

### 1. Valkey in place of Redis

The graduation task brief names Redis for background queueing, caching, and rate limiting.

- **Substitution:** One Aiven for Valkey service on the Free-1 tier (`rota-valkey`).
- **Why:** Valkey is an open-source, API-compatible fork of Redis created by the Linux Foundation after Redis switched license models. Aiven provides a managed free-tier Valkey service without payment card requirements, matching Rota's zero-cost infrastructure mandate.
- **Client library:** `ioredis` pinned to `5.11.1` and `bullmq` pinned to `6.3.17`.
- **Policy enforcement:** Configured with `maxmemory-policy: noeviction` (required by `AGENTS.md` and `jobs.md`). Worker refuses startup if `noeviction` cannot be verified.
- **Status:** Recorded in `docs/decisions/0003-queue-worker-and-recovery.md` (ADR 0003). Facilitator sign-off pending.

### 2. Decoupled Producer and Consumer Connection Policies

- **Producer (Enqueue path):** `ioredis` configured with `connectTimeout: 2000`, `commandTimeout: 2000`, `maxRetriesPerRequest: 1`, and `enableOfflineQueue: false`. Wrapped with a strict 2-second timeout boundary. If Valkey is unavailable or slow, the database work row remains committed as `pending` with `available_at = now()`, preventing API request threads from blocking.
- **Recovery from a half-open connection (ADR 0018, issue #39):** a connection that dies silently never emits `close`, so ioredis keeps calling it `ready` while every command times out. A timeout on a `ready` producer connection (the rate limiter, the API's queue producer and the reconciliation sweep's queue) replaces it with `disconnect(true)`. No new setting. A clean drop already reconnects by itself.
- **Consumer (Worker path):** `ioredis` configured with `maxRetriesPerRequest: null` for BullMQ blocking commands, with `lockDuration: 30000`, `stalledInterval: 15000`, and `maxStalledCount: 2`. **Consumer recovery (ADR 0018, issue #39):** BullMQ's blocking command never fails on a half-open connection, so a watchdog (`jobs/consumer.ts`) sends a `PING` every `BULLMQ_STALLED_INTERVAL_MS` (2 s limit) and rebuilds the connection and the worker when it goes silent, or when a connection stays in the ioredis handshake for two probes. A rebuild never starts while another is running. Known limit: if only BullMQ's duplicated blocking connection dies, the probe is still answered and nothing is rebuilt.

### 3. Shard Routing for Queued Work

- Every job payload in BullMQ carries a validated server-generated shard identifier (`shard: 'A' | 'B'`).
- The worker dynamically routes claim queries and row inspections to the matching shard primary (`shards[shard].primary`).
- Missing work rows throw explicit errors to immediately expose routing failures rather than silently disguising them as completed work.

### 4. Reconciliation Sweep

- Postgres work rows are the record; the Valkey queue can lose jobs. `server/src/jobs/reconcile.ts` runs inside the worker process on its own timer (default every 30 minutes, `RECONCILE_INTERVAL_MS`), at startup, and after a Valkey reconnect. It is independent of BullMQ.
- Per shard it picks a batch of rows with `FOR UPDATE SKIP LOCKED` (the lock covers only the pick), then, after commit, looks up each pending row's `work-<id>-<generation>` job: missing → add with the remaining delay; waiting, delayed or active → leave; failed or completed → new generation.
- Expired claims move to a new generation (or to `failed` when no attempts remain). A job that keeps failing before it ever claims is capped by `recovery_count` (`WORK_MAX_RECOVERIES`, default 5) and then marked `failed`.
- A Valkey failure ends that shard's pass and leaves rows eligible; a Postgres failure on one shard does not stop the other. Recorded in `docs/decisions/0004-reconciliation-sweep.md`.

### 5. Authentication API

Identity lives on shard A only (`users`, `credentials`, `refresh_token_families`, `refresh_tokens`) and is read and written
through its **primary**, never a replica (`server/src/db/identity.ts`). Decisions and numbers: ADR 0005 (tokens, sessions,
password policy), ADR 0006 (Argon2id), ADR 0007 (rate limiting). Threat write-up: `docs/SECURITY.md`.

| Route | Type | Checks, in order | Success |
|---|---|---|---|
| `POST /auth/register` | public | Zod, rate limit (`register_ip`), handler | `201 { user, session }` |
| `POST /auth/login` | public | Zod, rate limit (`login_ip`, `login_email`), handler | `200 { user, session }` |
| `POST /auth/refresh` | public | Zod, rate limit (`refresh_ip`), handler | `200 { session }` |
| `GET /auth/me` | user | Zod, access token, session check, handler | `200 { user }` |
| `POST /auth/logout` | user | Zod, access token, session check, handler | `204`, this device only |
| `POST /auth/logout-all` | user | Zod, access token, session check, handler | `204`, every device |

- `session` is `{ accessToken, accessTokenExpiresAt, refreshToken }`. Responses that carry tokens send `Cache-Control: no-store`.
- The access token is a JWT (HS256) with `sub` and `sid` (the session, i.e. refresh-token family) only. Every authenticated
  request re-checks the session on shard A's primary, so a logout or a detected theft stops the very next request.
- Refresh rotates the token inside one transaction that locks the family row (`FOR UPDATE`). Logout and logout-all take the
  same lock (logout-all locks the user's families in id order), which is what makes them safe against a refresh in flight.
- **Error body, every route:** `{ "error": { "code", "message", "requestId", "details"? , "retryAfterSeconds"? } }`. The app
  switches on `code`; `message` is for debugging. `details` is `[{ path, code, min?, max? }]` and never contains the
  submitted value. The `X-Request-Id` header equals `requestId`.

| `code` | HTTP | When |
|---|---|---|
| `validation_failed` | 400 | Body, query or params failed Zod (unknown keys included) |
| `invalid_json` | 400 | Body is not valid JSON |
| `payload_too_large` | 413 | Body over the 10 kb limit |
| `unauthenticated` | 401 | Any bad, expired, revoked or reused access or refresh token. One code on purpose: the reason is in the server log only |
| `invalid_credentials` | 401 | Login: unknown email and wrong password look identical |
| `email_in_use` | 409 | Register: the address already has an account (accepted trade-off, ADR 0005) |
| `forbidden` | 403 | A team member whose role may not do this (ADR 0014). Never used for another team's data: that is `not_found` |
| `not_found` | 404 | Unknown route, or a team the caller is not in (identical to one that does not exist) |
| `invite_unavailable` | 404 | An invitation link that cannot be used, whatever the reason (unknown, malformed, wrong team ID, expired, used, revoked) |
| `invite_wrong_account` | 403 | A signed-in holder of a valid link whose account is not the invited address. Nothing is granted |
| `already_member` | 409 | Inviting an address that is already on the team |
| `invite_pending` | 409 | Inviting an address that already has a pending invitation |
| `rate_limited` | 429 | Over a limit; `Retry-After` header and `retryAfterSeconds` |
| `internal_error` | 500 | Unexpected; nothing about it is sent |
| `service_unavailable` | 503 | Valkey is down (limited routes fail closed), or the database could not start a transaction in time. Safe to retry |

### 5a. Teams and roles API

Team rows and memberships live on **the team's shard** (chosen by the hash of the server-generated `team_id`); the user-to-teams directory
`user_teams` lives on shard A (ADR 0013). Roles are read from the team shard's **primary** on every request (ADR 0014). The one permission
table is `server/src/teams/permissions.ts`, mirrored in `docs/SECURITY.md`. Every `:teamId` is canonical lowercase hyphenated or the request is 400.

| Route | Type | Checks, in order | Success |
|---|---|---|---|
| `POST /teams` | user | Zod, access token, session check, rate limit (`team_create_user`, 5 per hour), handler | `201 { team, role: "owner" }` |
| `GET /teams` | user | Zod, access token, session check, handler | `200 { teams: [{ id, name, timeZone, role }] }` |
| `GET /teams/:teamId` | team | Zod, access token, session check, membership and role (`team.view`) | `200 { team, role }` |
| `GET /teams/:teamId/members` | team | Zod, access token, session check, membership and role (`members.list`) | `200 { members: [{ userId, name, role, joinedAt }] }` |

- Creating a team writes the directory row on shard A first, then the team and its Owner membership in one transaction on the team's shard.
  A failure in between leaves an inert directory row (ADR 0013). Exactly one Owner per team is enforced by a partial unique index.
- `GET /teams` reads the directory, then verifies each team against its own shard's memberships (one read per shard that appears).
- The member list takes names from shard A in one batched query and never includes email addresses.
- A team the caller is not in answers `404 not_found`, identical to a team that does not exist; a member without the permission answers `403 forbidden`.

### 5b. Invitations API and the email job

An invitation is team-owned: it lives on the team's shard, and so does its email work row, **written in the same transaction** (the foreign key
`invitations.email_work_row_id` is same-database); only after the commit is the job enqueued, and an enqueue failure never fails the request
(the row becomes eligible at once for the sweep). Decisions: ADR 0015 (invites), ADR 0016 (the email job). Link: `https://rota.davebuilds.design/invite/<teamId>.<secret>`.

| Route | Type | Checks, in order | Success |
|---|---|---|---|
| `POST /teams/:teamId/invitations` | team | Zod, token, session, per-user limit, membership and `invite.<role>`, team limit, app-wide cap | `201 { invitation }` |
| `GET /teams/:teamId/invitations` | team | Zod, token, session, membership and `invitations.list` | `200 { invitations: [{ id, email, role, expiresAt, emailStatus, canResend, canRevoke }] }` |
| `POST /teams/:teamId/invitations/:id/resend` | team | as create, for that invitation's role | `200 { invitation }` (new token, new email row) |
| `DELETE /teams/:teamId/invitations/:id` | team | Zod, token, session, membership and `invite.staff` gate, then the invitation's own role | `204` |
| `POST /invitations/preview` `{ token }` | public | Zod, IP limit, optional session | `200 { status: 'pending', team, role, inviter, email, account }`, or for the account that already accepted `200 { status: 'already_member', team: { id, name, timeZone }, role }` |
| `POST /invitations/accept` `{ token }` | invite accept | Zod, IP limit, token, session, user limit | `200 { team, role }` |

- **Accept and preview are idempotent for the account that already accepted** (accept: the same `200 { team, role }`; preview: `200 { status: 'already_member', team, role }`; nothing written either way); every other caller of a spent link gets the identical `404 invite_unavailable` (ADR 0015, ADR 0017).
- `emailStatus` is `queued`, `sent` or `failed`, read from the invitation's latest email work row. Resend and Revoke stay available in every state.
- `GET /teams/:teamId` also returns `invitableRoles` and `canManageInvitations`, computed from the permission table; the app offers only those.
- Errors: `404 invite_unavailable` (unknown, malformed, wrong team, expired, used, revoked: one identical answer), `403 invite_wrong_account`,
  `409 already_member`, `409 invite_pending`, `403 forbidden`, `404 not_found`, `429`, `503`.
- **The worker** runs the `email` job: `work_rows.payload` is the frozen Resend request; the job stamps `first_attempt_at` before the first call, sends with
  the key `email-<rowId>`, records `sent_at` and Resend's message ID, and scrubs the body and link. Terminal failures (the 23-hour rule, a spent daily quota,
  a rejected request) mark the row `failed` without retrying. The worker needs `RESEND_API_KEY`; the API needs `MAIL_FROM` and `MAIL_REPLY_TO`.

### 5c. Password reset and magic link

Four public routes under `/auth` (ADR 0020), each Zod, then rate limit, then handler: `POST /auth/magic-link/request`, `/auth/magic-link/redeem`, `/auth/password-reset/request`, `/auth/password-reset/submit`. Tokens live in `auth_tokens` on shard A, hash only; the email work row is written in the same transaction (the invite pipeline: frozen payload, one idempotency key per row, the email job skips a link that is used, replaced or expired). A request answers `202` immediately and makes the token in a tracked background step (so a known and an unknown address take the same time); shutdown drains it. A magic link starts a session like login (and, for an unverified address, clears the password and revokes every session first); a reset sets the password, revokes every session and signs nobody in. Link host: `https://rota.davebuilds.design/magic/<token>` and `/reset/<token>` (App Links, ADR 0009, ADR 0019).

### 6. Mobile app

Expo SDK 58 (React Native 0.88, React 19.3), TypeScript, Android only, Expo Router (ADR 0009). The decisions, the native-module list and
the 16 KB page-size audit are in ADR 0011. Where each piece of data lives: `docs/STATE.md`.

```
app/src/
  app/         Expo Router routes (a file here is a screen and a URL)
  api/         API client (one refresh in flight, stale-account discard), errors, config, cache times
  auth/        account epoch, token store (secure-store), local sign-out, logout
  state/       the Zustand store (session status, selected team, UI flags)
  teams/       team API calls and parsers, the create-team form rules, the time zone list (app side of section 5a)
  invites/     the invite link: preview and accept calls, parsers, failure mapping, the screen's states, return after sign-in (ADR 0017)
  theme/       design tokens mirrored from Figma: palette, colours (light/dark), dimensions, typography
  ui/          components built only from the tokens
  services.ts  composition root: the real client, query client, sign-out, query managers
```

- **Layering.** `api/` and `auth/` are plain TypeScript with injected dependencies (fetch, token store, connectivity, epoch), so the
  rules in `app-state.md` are unit-tested without a device. `services.ts` is the only file that wires the real ones together.
- **The app never decides anything that matters** (`AGENTS.md` rules 2 and 3). It holds no money logic, no plan table and no permission
  rules; it sends requests and displays what the server answers.
- **Design tokens** mirror Figma's three variable collections one-to-one (`Rota / Primitives` -> `palette.json`, `Rota / Colour` ->
  `colors.ts` with Light and Dark, `Rota / Dimensions` -> `dimensions.ts`) and the six text styles -> `typography.ts`. Raw hex values exist
  only in `palette.json`, which `app.config.ts` also reads so the splash and notification colours come from the same source.
- **Reset and magic link** (ADR 0020). `/forgot-password` (Figma 8:74, then the "Check your inbox" layout) and `/magic-sent` (8:47) sit on the signed-out side; `/magic/[token]` (8:61) and `/reset/[token]` (8:86) are reachable signed in or out, like `/invite/[token]`. Opening a link consumes nothing; the button's `POST` does. The token stays in memory in the route.
- **Deep links.** Scheme `rota`, and https App Links on `rota.davebuilds.design` for `/invite`, `/magic`, `/reset` and `/checkout`
  (verification goes live when the GitHub Pages site in `site/` is deployed and its DNS record is live, ADR 0019). Opening a link consumes nothing.
- **Team directory and invite form** (`app/(app)/team/`): reached from the placeholder home's "Team" button until the tab bar exists (its other tabs have no screens yet). The roster and what the caller may do come from the server (`GET /teams/:id` and `…/members`); "Invite a teammate" shows only when `invitableRoles` is not empty, and the role sheet offers exactly those roles. Every state has a screen: loading, empty (only you), error with Try again (including when the team list itself could not load), offline. For an Owner or Manager the directory previews the oldest pending invitation and links to **Pending invitations**: every pending invitation with the server's email state ("Email not sent" in red when the worker gave up), and Resend and Revoke exactly where the server says the caller may (a Manager sees an Owner's Manager invitation without buttons). Revoke has its own confirmation. "Create a shift" waits for shifts.
- **The invite link** opens `invite/[token]`, a root route outside both session guards (so it works signed in or out). Sign in and Create account open on top of it carrying the token as route params, and once the session starts they return to it with `dismissTo`; Accept puts the accepted team in the teams list and selects it. Every exit goes through `goBackTo`. Details and the bugs that shaped it: ADR 0017.
- **Native modules** are fixed at build time. Everything the whole app needs is installed up front so the limited EAS build quota is spent
  once (`expo-builds.md`, ADR 0011).

---

## What changes in production

1. **Read-your-own-writes and API clustering:**
   The current 5-second read-your-own-writes mechanism uses an in-memory map valid for **exactly one API process** with stop-then-start deployments. In a multi-instance production environment, this must be replaced by a position-based design (comparing the replica's WAL replay position with the user's last write commit LSN stored in Postgres or session state).
2. **Replication lag:**
   If a provider does not provide separate read replicas on the free plan, a second read connection string is used for code-level read/write routing. In production with actual replicas, replication lag becomes physical; read-your-own-writes ensures users see their own immediate writes.
3. **Queue clustering:**
   A single Aiven Valkey node periodic snapshot model means the queue is transient. Postgres remains the single source of truth for all work rows. In high-volume production, Valkey multi-node HA or Sentinel would provide queue persistence across node failures.
