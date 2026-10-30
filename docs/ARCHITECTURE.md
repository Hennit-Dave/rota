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
| `POST /teams/:teamId/invitations/links` | team | Zod (no body), token, session, per-user link limit, membership and `invite.staff`, team link limit (never the email cap) | `201 { invitation, link }` (Staff, no email; the link is in this answer only) |
| `POST /teams/:teamId/invitations` | team | Zod, token, session, per-user limit, membership and `invite.<role>`, team limit, app-wide cap | `201 { invitation }` |
| `GET /teams/:teamId/invitations` | team | Zod, token, session, membership and `invitations.list` | `200 { invitations: [{ id, kind, email, role, expiresAt, emailStatus, canResend, canRevoke }] }` (`kind` is `email` or `link`; a link has `email` and `emailStatus` null and `canResend` false) |
| `POST /teams/:teamId/invitations/:id/resend` | team | as create, for that invitation's role | `200 { invitation }` (new token, new email row) |
| `DELETE /teams/:teamId/invitations/:id` | team | Zod, token, session, membership and `invite.staff` gate, then the invitation's own role | `204` |
| `POST /invitations/preview` `{ token }` | public | Zod, IP limit, optional session | `200 { status: 'pending', team, role, inviter, email, account }`, or for the account that already accepted `200 { status: 'already_member', team: { id, name, timeZone }, role }` |
| `POST /invitations/accept` `{ token }` | invite accept | Zod, IP limit, token, session, user limit | `200 { team, role }` |

- **Accept and preview are idempotent for the account that already accepted** (accept: the same `200 { team, role }`; preview: `200 { status: 'already_member', team, role }`; nothing written either way); every other caller of a spent link gets the identical `404 invite_unavailable` (ADR 0015, ADR 0017).
- `emailStatus` is `queued`, `sent` or `failed`, read from the invitation's latest email work row. Resend and Revoke stay available in every state.
- **Invite links (ADR 0025):** `invitations.kind` is `email` or `link`. A link is Staff only, not tied to an address, single use, lives `INVITE_LINK_EXPIRY_HOURS` (48), at most `INVITE_LINK_MAX_PENDING` (10) pending per team (counted under a lock on the team row), creates no work row and enqueues nothing. Preview answers `{ kind: 'link', email: null, account: 'open' | 'none' }`; accept lets any signed-in account in, verifies no address, and for someone already on the team answers with the role they hold and consumes nothing. Revoke is the same `DELETE`; a link cannot be resent. New error: `409 invite_link_limit`.
- `GET /teams/:teamId` also returns `invitableRoles`, `canManageInvitations`, `canCreateInviteLink` and `canEditShifts`, computed from the permission table; the app offers only those.
- Errors: `404 invite_unavailable` (unknown, malformed, wrong team, expired, used, revoked: one identical answer), `403 invite_wrong_account`,
  `409 already_member`, `409 invite_pending`, `403 forbidden`, `404 not_found`, `429`, `503`.
- **The worker** runs the `email` job: `work_rows.payload` is the frozen Resend request; the job stamps `first_attempt_at` before the first call, sends with
  the key `email-<rowId>`, records `sent_at` and Resend's message ID, and scrubs the body and link. Terminal failures (the 23-hour rule, a spent daily quota,
  a rejected request) mark the row `failed` without retrying. The worker needs `RESEND_API_KEY`; the API needs `MAIL_FROM` and `MAIL_REPLY_TO`.

### 5c. Password reset and magic link

Four public routes under `/auth` (ADR 0020), each Zod, then rate limit, then handler: `POST /auth/magic-link/request`, `/auth/magic-link/redeem`, `/auth/password-reset/request`, `/auth/password-reset/submit`. Tokens live in `auth_tokens` on shard A, hash only; the email work row is written in the same transaction (the invite pipeline: frozen payload, one idempotency key per row, the email job skips a link that is used, replaced or expired). A request answers `202` immediately and makes the token in a tracked background step (so a known and an unknown address take the same time); shutdown drains it. A magic link starts a session like login (and, for an unverified address, clears the password and revokes every session first); a reset sets the password, revokes every session and signs nobody in. Link host: `https://rota.davebuilds.design/magic/<token>` and `/reset/<token>` (App Links, ADR 0009, ADR 0019).

### 5d. Shifts API

Five routes under `/teams/:teamId/shifts` (ADR 0021), each Zod (strict, params, query and body), token and session check, `requireTeamRole`: `GET /` (shifts that overlap `[from, to)`, soonest first, `mine=true` for the caller's own, range capped at 42 days), `GET /:shiftId`, `POST /` (201), `PATCH /:shiftId` (only the sent fields; `null` clears an optional field or unassigns) and `DELETE /:shiftId` (204). `shifts.view` is every role, `shifts.edit` is Owner and Manager. Rows live on the team's shard. Times are UTC instants (`timestamptz(3)`); the team's time zone is only for display, in the app. Every write is one transaction that also inserts an `activity` row, so the feed (next slice) can never disagree with the data; a write to a person's shifts first takes a `FOR UPDATE` lock on their membership row, which makes the no-overlap rule (`409 shift_overlap`) safe under concurrency. Errors: `400 validation_failed` (detail codes `must_be_after_start`, `break_too_long`, `range_too_long`, `not_a_member`, `nothing_to_change`), `403 forbidden`, `404 not_found` (also another team's shift), `409 shift_overlap`, `429`, `503`. Responses carry `Cache-Control: no-store`. `GET /teams/:teamId` also returns `canEditShifts`.

### 5e. Activity feed API

One route, `GET /teams/:teamId/activity?limit&cursor` (ADR 0022). A team route: Zod (strict) on params and query, token and session, the per-user feed rate limit (`feed_user`, 120 per minute, fail closed with `503` when Valkey is down), then membership and role from the team shard's primary (`shifts.view`, every role). Rows are the `activity` rows the shift routes write in the same transaction as each change (ADR 0021). Newest first by `(created_at, id)` descending; a page is the rows strictly older than the cursor, read with `LIMIT limit + 1` (the extra row only says whether a next page exists). `limit` defaults to 20 and is at most 50. The cursor is opaque base64url of `{t, i}` built by the server from the last row, decoded and validated field by field (anything else is `400 invalid_cursor`) and carries no team. Index `activity (team_id, created_at DESC, id DESC)`. Response: `{ items: [{ id, kind, createdAt, actor: {id, name} | null, shiftId, shift: {title, startsAt, endsAt} | null, changed: [fieldName] }], nextCursor: string | null }`, `Cache-Control: no-store`. There is no server-side cache of the first page yet (it arrives with the load-test slice, `caching.md`). Errors: `400 validation_failed` (`limit_too_large`, `invalid_cursor`), `401`, `404` (not a member, or no such team), `429`, `503`.

`npm run db:feed-proof -- seed | explain | clean` (test shards only, guarded by `TEST_DATABASE_ALLOWED`) seeds 10,000 rows for one team on one shard and a small team on the other, and prints `EXPLAIN (ANALYZE, BUFFERS)` of the exact feed query on the primary.

### 5f. Swaps API

Routes under `/teams/:teamId/swaps` (ADR 0023), each Zod (strict, params and body), token and session, then membership and role from the team shard's primary: `GET /` (the caller's own swaps, as requester or as the other person; for an Owner or Manager also every swap waiting for a decision; newest first, at most 50), `GET /:swapId`, `POST /` (the requester's own shift and a teammate's, by ID; header `Idempotency-Key`; `201` when created, `200` when it is the stored answer to a repeat), `POST /:swapId/cancel` (the requester, while it waits), `POST /:swapId/approve` and `/reject` (`swaps.approve`; never by someone who is part of the swap, except an Owner who is the only approver). `swaps.request` is every role. Creating is limited to 10 per user per hour (`swap_request_user`, fail closed with `503` when Valkey is down) and at most 3 waiting per person (`SWAPS_MAX_PENDING`). Rows live on the team's shard in `swap_requests`, with a snapshot of both shifts and `UNIQUE (team_id, requester_user_id, idempotency_key)`. Approval is one transaction: it locks the request, both people's membership rows and both shifts, re-checks them against the live rows (same owners, same times, still in the future, nobody double-booked), swaps the two assignees, and writes a `swap_approved` feed row; if anything fails the answer is `409 swap_not_possible` and the request stays pending. Each swap carries the server's own `canCancel` and `canDecide`. Errors: `400 validation_failed` (`not_yours`, `not_swappable`, `in_past`, `key_reused`, header `invalid`), `403`, `404`, `409` (`swap_limit_reached`, `swap_not_pending`, `swap_not_possible` with `already_in_swap`, `would_double_book`, `shift_changed`, `someone_left`), `429`, `503`. `Cache-Control: no-store`. Feed rows: `swap_requested`, `swap_approved`, `swap_rejected` (the feed's `shift` is the shift the requester offered).

### 5g. Settings API

Routes under `/settings` (ADR 0024), user routes (no team, no role): Zod (strict, params, query and body), access token and session check, the per-user rate limit, handler. The user is always the signed-in one: there is no way to name someone else's settings. `GET /settings` answers every setting as `{ value, updatedAt }` (`updatedAt` is `null` while a setting was never changed and the value is the default; a user with no row gets the defaults and nothing is written). `PATCH /settings` changes **one** setting per request (`quietHours {enabled,start,end}` as one unit, `timeZone`, `notifyShiftChanges`, `notifySwapUpdates`, `notifyBilling`, `language` (`en` only), `theme` (`system`, `light`, `dark`)): a body with two settings, none, an unknown key, or a client-sent `updatedAt` or user ID is `400`. The change is one `INSERT … ON CONFLICT DO UPDATE` setting the value and that setting's `<name>_updated_at = clock_timestamp()` in the database (the stamp is the server's, taken after the row lock); the most recent change to a setting wins, and a change to one setting never touches another's stamp. The row lives in `user_settings` on shard A (identity data, foreign key to `users`, `ON DELETE CASCADE`), read and written on the primary, never cached in Valkey. Limits: `settings_read_user` 120 per minute and `settings_write_user` 30 per minute (proposed, chosen, not measured; fail closed with `503` when Valkey is down). Errors: `400 validation_failed`, `401`, `429`, `503`. `Cache-Control: no-store`. **Not built here:** enforcing quiet hours and the time zone. The push job (later) will call one pure decision function, re-read the user's settings when it runs, and a change to quiet hours or the time zone will reschedule that user's pending push rows in the same transaction (`jobs.md`, ADR 0024).

### 5h. Billing engine and schema (ADR 0026)

The endpoints are section 5i; this section is the part underneath them. `server/src/billing/` is pure code: `plans.ts` (prices, the only place they live), `periods.ts` (calendar-month anniversaries from the activation day, clamped; `period_days` 28 to 31), `proration.ts` (`quoteChange`: splits a change into what applies now and what waits for the period end, prices the part that applies now against `paid_basis` with `floor(new × remaining ÷ days) − floor(paid_basis × remaining ÷ days)` in `BigInt`), `ledger.ts` (the rows a change writes, and `rebuildSubscription`, the fold from ledger rows back to state). The app holds none of it.

Tables (migration `20261028190000_add_billing`, applied to both shards like every migration; the team tables are used on the team's shard, `stripe_events` on shard A): `billing_periods`, `subscriptions` (a projection of the ledger; no row until the team activates), `payment_operations` (frozen quotes, one open per team by a partial unique index, the payment ID unique across operations), `payment_requests` (Idempotency-Key, fingerprint, stored answer), `ledger_entries` (append-only by trigger: `UPDATE`, `DELETE` and `TRUNCATE` are rejected), `stripe_events` (the webhook inbox, unique by event ID). Integer cents only; currency `usd`. No foreign key from a billing table to `teams`. The Stripe flow (Checkout, the webhook route, the processing job) is section 5i; this integration uses Stripe test mode only, and live-payment eligibility has not been verified.

### 5i. Activation: Checkout, the webhook, the processing job and seat limits (ADR 0027)

Routes (Owner only, `billing.manage`; Zod on params, query and body; `Cache-Control: no-store`), mounted at `/teams/:teamId/billing`: `GET /` (what the team has and could buy, every price a finished string), `GET /activation-quote?plan=&seats=` (read-only), `POST /activation` (`Idempotency-Key`; freezes the operation and makes the one bounded Stripe call), `GET /operations/:operationId` (the server's word: `awaiting_payment`, `confirming`, `paid`, `failed`, `expired`, `under_review`), `POST /operations/:operationId/cancel`. A rate limit applies to the writes (`billing_user`, SECURITY.md). Code: `server/src/billing/` (`activation.ts` the service, `gateway.ts` the only file that talks to Stripe, `stripeConfig.ts` refuses anything but an `sk_test_` key, `webhook.ts`, `stripeEvent.ts`, `stripeEventJob.ts`, `seats.ts`, `routes.ts`).

The webhook is `POST /webhooks/stripe`: `express.raw` on that route only, registered before every router; signature verified on the raw bytes before anything is parsed or logged; live-mode events refused; the event and its work row (`kind = 'stripe_event'`) committed together on shard A, unique by event ID; enqueued; 200. The job (worker) matches the payment against the frozen operation and applies it in one transaction on the team's shard (the period, the ledger rows, the subscription, the operation completed), then marks the inbox row processed. The Stripe key is read only by the API; the worker holds no Stripe key.

Seat limits: `billing/seats.ts`, called from the invitation service while holding the team row lock, when an invitation is made (members plus usable invitations) and, authoritatively, when one is accepted. App: `app/src/billing/` and the screens under `app/src/app/(app)/billing/`, plus the `checkout/return` and `checkout/cancel` routes that Stripe's redirect opens. This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

### 5j. Plan and seat changes, and the billing history (ADR 0028)

Routes, Owner only, at `/teams/:teamId/billing`: `GET /change-quote?plan=&seats=` (what a change costs and when it starts, in finished text), `POST /changes` (Idempotency-Key; a change that needs no payment applies at once, a paid one is frozen and sent to Checkout), `GET /history` (the ledger, grouped by operation). Code: `server/src/billing/changes.ts` (the state, the wording, the apply, the history), `checkout.ts` (what activation and changes share: freezing, the Idempotency-Key, the one Stripe call), `ledgerDb.ts` (the one place ledger rows are inserted). The engine is `proration.ts` and is not touched.

The job applies a paid change only against the subscription version it was quoted against, re-derives the charge with our engine, and writes the credit, the charge and the entitlement change in one transaction. App: `app/src/app/(app)/billing/` (`index.tsx` the hub, `change.tsx`, `history.tsx`). This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

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
  swaps/       the swap API call (with the idempotency key), parsers, the optimistic mutation and its helpers, text and failure mapping (app side of section 5f)
  activity/    the feed: API call, parsers, paging helpers (`mayFetchNextPage`, `keepFirstPage`, `feedState`), the label and time text, the hook (app side of section 5e)
  shifts/      shift API calls and parsers, the team-clock maths (`shiftTime.ts`), the form rules, failure mapping, the schedule's components and hooks (app side of section 5d)
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
- **Schedule and the tab bar** (ADR 0021): `/` is the Schedule (Figma 04): a week strip, the shifts of the chosen day from one request for the whole week, and for an Owner or Manager every shift of the team plus "Create shift" (shown when the server's `canEditShifts` says so); Staff see only their own. `/shift/new`, `/shift/[shiftId]` (detail, with who else is working at the same time), `.../edit`, `.../delete` and `/shift/published` are the rest of the flow. The bottom bar (Schedule, Team, Settings; Swaps is drawn and disabled until the swaps slice) is on each tab's screen. Schedule is the root: Team and Settings are pushed on top of it, a press on Schedule pops back to it, and Team and Settings replace each other, so Back from any tab lands on Schedule and one more Back leaves the app (`ui/navAction.ts`). Settings (`/account`) is the Settings screen (see below); the sign-out buttons moved to `/account/sessions`, reached from it. Dates and times are typed (a native picker would need a new build) and read on the team's clock.
- **Settings** (ADR 0024, Figma 09): `/account` shows the person's settings from the server (quiet hours, the three notification types, theme, time zone, language) and a button to `/account/sessions` (Account & sessions: who is signed in, log out, log out everywhere). `/account/quiet-hours` edits quiet hours (typed 24-hour times, a time zone, "Turn quiet hours off"). Each change is its own optimistic update with rollback and its row is disabled while it is pending; saving, saved, failed and offline are shown on Settings itself. The theme setting colours every signed-in screen (the signed-out side stays light); the launch screen waits for the first settings answer so the first frame is already in the person's theme. The app never sends or invents a timestamp, and nothing is queued offline.
- **Team activity** (`/activity`, Figma 04): opened from Schedule's "View activity". `useInfiniteQuery` with the server's cursor and FlashList (a JavaScript-only list, no native build), pull to refresh (it starts again from page one, so a refresh after a long scroll is one request, not one per page loaded). The next page is asked for only when `hasNextPage && !isFetchingNextPage` and the last attempt did not fail, so fast scrolling sends no duplicate requests. Bodies: skeleton rows while loading, rows with a "Loading more" footer, "You're all caught up" at the end, "No activity yet", and "Couldn't load activity" with Try again (a query that is neither fetching nor failed, such as a retry TanStack paused, is shown as that error, never as an endless skeleton). "Today" and "Yesterday" are counted on the team's calendar. A shift write invalidates the feed the app holds.
- **Swaps** (`/swaps`, Figma 06; the Swaps tab): the list (your own requests; for an Owner or Manager also the ones waiting for a decision), `/swaps/new` (pick your shift and a teammate's), `/swaps/confirm` ("Does this look right?", then the request as an optimistic update: "Request sent" at once with the control off, the server's answer replaces the guess, a failure puts the list back and says why, offline nothing is sent or queued) and `/swaps/[swapId]` ("Review swap" with Approve and Reject for someone who may decide; the same screen shows Request sent, Swap approved or Swap not approved by what the swap is now). The buttons are the server's `canDecide` and `canCancel`. The idempotency key is made once when the confirm screen opens, so Try again sends the same key.
- **Team directory and invite form** (`app/(app)/team/`): reached from the Team tab. The roster and what the caller may do come from the server (`GET /teams/:id` and `…/members`); "Invite a teammate" shows only when `invitableRoles` is not empty, and the role sheet offers exactly those roles. Every state has a screen: loading, empty (only you), error with Try again (including when the team list itself could not load), offline. For an Owner or Manager the directory previews the oldest pending invitation and links to **Pending invitations**: every pending invitation with the server's email state ("Email not sent" in red when the worker gave up), and Resend and Revoke exactly where the server says the caller may (a Manager sees an Owner's Manager invitation without buttons). Revoke has its own confirmation. 
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
