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
- **Consumer (Worker path):** `ioredis` configured with `maxRetriesPerRequest: null` for BullMQ blocking commands, with `lockDuration: 30000`, `stalledInterval: 15000`, and `maxStalledCount: 2`.

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
| `not_found` | 404 | Unknown route |
| `rate_limited` | 429 | Over a limit; `Retry-After` header and `retryAfterSeconds` |
| `internal_error` | 500 | Unexpected; nothing about it is sent |
| `service_unavailable` | 503 | Valkey is down (limited routes fail closed), or the database could not start a transaction in time. Safe to retry |

---

## What changes in production

1. **Read-your-own-writes and API clustering:**
   The current 5-second read-your-own-writes mechanism uses an in-memory map valid for **exactly one API process** with stop-then-start deployments. In a multi-instance production environment, this must be replaced by a position-based design (comparing the replica's WAL replay position with the user's last write commit LSN stored in Postgres or session state).
2. **Replication lag:**
   If a provider does not provide separate read replicas on the free plan, a second read connection string is used for code-level read/write routing. In production with actual replicas, replication lag becomes physical; read-your-own-writes ensures users see their own immediate writes.
3. **Queue clustering:**
   A single Aiven Valkey node periodic snapshot model means the queue is transient. Postgres remains the single source of truth for all work rows. In high-volume production, Valkey multi-node HA or Sentinel would provide queue persistence across node failures.
