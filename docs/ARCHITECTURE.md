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

---

## What changes in production

1. **Read-your-own-writes and API clustering:**
   The current 5-second read-your-own-writes mechanism uses an in-memory map valid for **exactly one API process** with stop-then-start deployments. In a multi-instance production environment, this must be replaced by a position-based design (comparing the replica's WAL replay position with the user's last write commit LSN stored in Postgres or session state).
2. **Replication lag:**
   If a provider does not provide separate read replicas on the free plan, a second read connection string is used for code-level read/write routing. In production with actual replicas, replication lag becomes physical; read-your-own-writes ensures users see their own immediate writes.
3. **Queue clustering:**
   A single Aiven Valkey node periodic snapshot model means the queue is transient. Postgres remains the single source of truth for all work rows. In high-volume production, Valkey multi-node HA or Sentinel would provide queue persistence across node failures.
