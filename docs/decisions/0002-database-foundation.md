# 0002: Database foundation, Prisma versions and shard function

- **Status:** proposed (accepted when Dave merges PR 1). Migration and `team_id` omission approved by Dave 2026-10-19.
- **Date:** 2026-10-19
- **Decided by:** Dave
- **Related:** issue #13 (Refs), PR `feat/db-shards`, `.agents/rules/data.md`, `.agents/rules/jobs.md`

## Problem

The infrastructure proof needs both Neon shards, a durable work table to prove queue-loss recovery from, and
a shard function every process agrees on. These choices are hard to change once data exists.

## Options considered

1. **Prisma 7.10.1 with `@prisma/adapter-pg`, all three pinned exactly:** `prisma`, `@prisma/client` and
   `@prisma/adapter-pg` are released together; mixed versions are a known source of breakage.
2. **Floating `^` ranges:** easier updates, but a lockfile-only guarantee of matching versions.
3. **Work table now with every `jobs.md` column, or a smaller first version:** a smaller first version needs
   fewer guesses; the omitted columns can be added later by an expand migration.

## Decision

- `prisma`, `@prisma/client`, `@prisma/adapter-pg` pinned to **7.10.1**. `pg` and `@types/pg` pinned to
  **8.23.1** (already pulled in by the adapter; declared so the parity script does not rely on a transitive
  dependency).
- Migrations run through each shard's **direct (unpooled)** URL, selected by `SHARD=a|b` in
  `server/prisma.config.ts`, with no default shard. Runtime uses the pooled `-pooler` URLs. If channel
  binding or pooled prepared statements fail, work **stops and is reported**; runtime traffic is never
  silently switched to direct URLs.
- First migration `init_work_rows` creates the `work_rows` table and `work_status` enum on **both**
  shards, applied A then B, checked with `npm run db:parity`.
- `shardFor(teamId)` is implemented exactly as specified in `data.md` (SHA-256 of the UTF-8 string, first 4
  bytes unsigned big-endian, mod 2) and checked against all three fixed vectors.
- **Deferred columns:** `origin_request_id` and `payment_operation_id` are **omitted for now**. They are
  correlation IDs logged by every execution (`observability.md`). They are added by a later expand
  migration when the request-ID logging slice (build order step 3) and the payment-operation row exist.
  Until then, executions log job ID, row ID, generation, attempts, outcome and duration only.
- **`work_rows` has no `team_id`.** `data.md` requires `team_id` only on *team-owned* tables, and no rule
  requires it on every table. The infrastructure-proof rows (test jobs, the Resend email) belong to no team,
  so there is nothing to put in the column and no team to route them by. Team-owned work rows get a
  `team_id` (and shard routing) in the slice that creates them.
- **Two indexes** were added beyond a bare table: `(status, available_at)` serves the timed sweep for
  pending rows past `available_at`; `(status, claim_expires_at)` serves recovery of claimed rows whose
  lease expired. Both are the two sweep queries in `jobs.md`; without them each sweep scans the table,
  and each sweep wakes Neon.
- **`run_at` and `available_at` columns default to `now()`; the application does not rely on the defaults
  for scheduled work.** The defaults are only a fallback so a row can never exist with a null time the
  sweep cannot compare. The migration is applied and is not rewritten. Two rules decide the values, and
  they are what make the sweep eligibility rule work:
  - **Normal work-row creation sets `available_at = run_at + 2 minutes`** (`jobs.md`, Scheduling). That
    gives the queue two minutes after the work is due to run it before the timed sweep treats the row as
    lost.
  - **An enqueue failure sets `available_at = now()`**, so the row is eligible for the next sweep or
    reconnect check at once.

  `run_at` is a separate matter: **the worker enforces it.** Claims require `run_at <= now()`
  (`jobs.md`, Ownership), and an early-firing job is moved to delayed, not run. Enforcing `run_at` alone
  does not say when a row is *eligible for the sweep*; `available_at` does. Delayed work always sets
  `run_at` explicitly. The next PR that creates work rows (PR 2) sets `available_at` explicitly and tests
  both rules.
- **Pooled shard clients are included in PR 1** (`src/db/clients.ts`, `getShard`), with a connection check
  against both shards (`npm run db:check-pooled`). Runtime clients read only the pooled URLs and never
  fall back to direct URLs. Pool maximum is a parameter (`data.md`: API 5, worker 3 per shard primary).

## Why

- Pinning follows the toolchain rule in ADR 0001: exact versions, committed lockfile.
- Peer ranges checked on 2026-10-19 from the npm registry: `prisma@7.10.1` requires `typescript >=5.4.0`;
  `@prisma/adapter-pg@7.10.1` depends on `pg ^8.16.3`. A peer range is not a statement of tested support.
  Behaviour against Neon's pooler was checked directly in this PR; see Evidence.
- `jobs.md` lease length, attempt maximum and backoff are **not** decided here: PR 1 contains no code that
  uses them. They are decided in the PR that first uses them.

## Consequences

- **Easier:** both shards share one schema, one migration history, one parity check.
- **Harder or given up:** the work table will need an expand migration for the deferred columns; any rows
  written before that have null correlation IDs.
- **Revisit when:** the request-ID logging slice lands, or the first team-owned work row is needed.

## Evidence

Migration SQL, the A-then-B apply output, migration status, the parity output, the pooled check and the
three passing vectors are in the PR description.

Verified 2026-10-19 (`npm run db:check-pooled`): both pooled URLs carry `channel_binding=require` and
connect; a raw query, a model query and a transaction succeed through the pooler on both shards. This
verifies the pooled connection only. The wider infrastructure gate (queue, worker, email, recovery) is
still open. Known warning: `pg` 8.23.1 prints that `sslmode=require` is currently treated as
`verify-full` and will change in pg 9. Not acted on; revisit at the next `pg` major.
