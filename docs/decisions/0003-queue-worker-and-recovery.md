# 0003: Queue and worker foundation, Valkey substitution, and durable claims

- **Status:** Accepted
- **Facilitator sign-off on Valkey replacing Redis:** pending
- **Date:** 2026-10-19
- **Decided by:** Dave
- **Related:** issue #13 (Refs), PR `feat/queue-worker`, `.agents/rules/jobs.md`, `docs/ARCHITECTURE.md`

## Problem

The infrastructure gate requires background job processing, delayed execution, retries with backoff, and worker restart recovery. The task brief specifies Redis, but Redis changed its licensing; an approved free cloud hosting solution is required. Additionally, transient network delays to the cache/queue must not block caller HTTP threads, and background job claims must survive concurrent workers and process crashes without double execution or lost work.

## Options considered

1. **Redis vs Valkey:**
   - *Redis:* Proprietary dual-license (RSALv2/SSPL). Managed options often require credit card validation or have expiring trials.
   - *Valkey:* Linux Foundation BSD-3-Clause open-source fork. Fully wire-compatible with Redis 7.2 APIs. Available on Aiven Free-1 plan without credit card requirement, keeping infrastructure completely free.
2. **Client libraries:**
   - *ioredis 5.11.1* pinned exactly: robust TLS support, independent producer/consumer configurations.
   - *bullmq 6.3.17* pinned exactly: full compatibility with ioredis `>=5.0.0`, mature delayed job scheduling and stalled-job recovery.
3. **Producer connection policy:**
   - *Default ioredis:* queues commands in memory when disconnected (`enableOfflineQueue: true`). If Valkey hangs, requests queue indefinitely and consume Node heap.
   - *Decoupled producer:* `enableOfflineQueue: false`, `connectTimeout: 2000`, `commandTimeout: 2000`, `maxRetriesPerRequest: 1`, plus a strict 2-second `Promise.race` wrapper.
4. **Attempt budgeting:**
   - *BullMQ attempts only:* Lost on queue loss or generation reset; does not enforce durable ceilings.
   - *PostgreSQL durable counter (`execution_attempts`):* Increments only on successful atomic claim. BullMQ attempts pace exponential retries, but the database counter determines the terminal `failed` state.

## Decision

1. **Valkey substitution:** Adopt Aiven for Valkey Free-1 tier (`rota-valkey`), using `ioredis@5.11.1` and `bullmq@6.3.17`.
2. **Configuration settings (approved for infrastructure proof):**
   - `WORK_LEASE_MS = 30000` (30 seconds). Handlers in PR 2 are lightweight test tasks (measured at ~211ms in the proof harness); 30s provides ample headroom against CPU pauses and network latency while allowing predictable recovery during test harnesses. Re-evaluated in PR 3 when Resend HTTP calls are introduced.
   - `WORK_MAX_ATTEMPTS = 5`. Durable ceiling in Postgres. Attempt 5 may succeed; failure on attempt 5 marks row `failed`; no 6th execution is permitted.
   - `WORK_BACKOFF_DELAY_MS = 2000` (2 seconds base, exponential: ~2s, 4s, 8s, 16s). Paces BullMQ retries.
   - `BULLMQ_LOCK_DURATION_MS = 30000`, `BULLMQ_STALLED_INTERVAL_MS = 15000`, `BULLMQ_MAX_STALLED_COUNT = 2`, `BULLMQ_JOB_ATTEMPTS = 5`.
3. **Producer timeout boundary:**
   Enqueue writes Postgres row first (`available_at = run_at + 2 minutes`). The BullMQ `queue.add` call is bounded by 2 seconds with `enableOfflineQueue: false`. If Valkey times out, rejects, or queue construction fails, `available_at` is updated to `NOW()` only for the matching generation while still `pending`, preventing caller threads from hanging. Late rejections and failures are logged safely.
4. **Shard routing:**
   Every queued job payload carries a validated server-generated shard identifier (`shard: 'A' | 'B'`). The worker processor dynamically routes claims and inspections to the correct shard primary. Missing work rows produce explicit errors and never disguise routing failures.
5. **`noeviction` verification:**
   Worker checks `INFO memory` (with fallback to `CONFIG GET maxmemory-policy`) on startup. If the policy is not `noeviction` or cannot be verified, startup is refused (`process.exit(1)`). The service configuration is never altered via `CONFIG SET`.
6. **Claim & contention rules:**
   - Atomic claim query matches `generation`, `run_at <= NOW()`, `(status = 'pending' OR (status = 'claimed' AND claim_expires_at < NOW()))`, and `execution_attempts < maxAttempts`.
   - Unsupported job kinds produce explicit failures and release the claim or mark failed; unperformed work is never marked done.
   - Live claims take precedence over exhaustion: duplicate delivery during an active 5th attempt is treated as contention, does not mark the row failed, and allows the active owner to complete `done`.
   - 3-field check on renewal, release, completion, and terminal failure (`status = 'claimed' AND generation = $gen AND claim_token = $token`).
7. **Recovery boundary (PR 2 vs PR 3):**
   - PR 2 proves worker-restart recovery via BullMQ stalled-job detection and expired-claim reclamation, and verifies early-fire delayed scheduling.
   - PR 3 implements the independent reconciliation sweep (`RECONCILE_INTERVAL_MS = 1800000`, approved; see ADR 0004). The end-to-end queue-loss proof (local Valkey, no `FLUSHALL`) is deferred to "Later proofs (not blocking)" in `AGENTS.md`.

## Why

- Aiven Valkey fulfills the assignment's caching/queuing requirements while honoring the zero-cost rule without expiring trial credits.
- Decoupling producer and consumer connection policies ensures database durability is preserved even during total cache outages without degrading API availability.
- Multi-field ownership checks and atomic claim queries guarantee database fencing: only the execution holding the matching claim token, generation, and `status='claimed'` can update or complete the row in Postgres. Claim tokens fence database mutations, not external side effects or all overlapping in-flight execution if a process hangs beyond its lease; idempotency with external services requires provider idempotency keys (`jobs.md`).

## Consequences

- **Easier:** Safe background execution with guaranteed database fallbacks; deterministic job deduplication and multi-shard routing.
- **Harder or given up:** If BullMQ exhausts its internal stalled-job allowance (`maxStalledCount`), the job is stranded until PR 3's independent sweep restores it.
- **Revisit when:** External HTTP handlers (Resend, Expo Push) are implemented, requiring measurement of real network latency against `WORK_LEASE_MS`.

## Evidence

- Unit tests (`server/src/jobs/worker.unit.test.ts`): 9 passing unit tests proving `noeviction` policy checks, deterministic custom job IDs, shard options validation, processor shard routing, and shard resolver dispatch with zero database mutations.
- Database integration tests (`server/src/jobs/worker.integration.test.ts`): 12 passing integration tests guarded by `TEST_DATABASE_ALLOWED=true` proving:
  - Unknown job kind explicit failure (unperformed work never marked done)
  - Shard routing across both Shard A and Shard B primaries with missing row detection
  - Actual simultaneous claim contention (loser contends without attempt penalty)
  - Timeout fallback preserving `claimed`, `done`, and `failed` rows untouched
  - Attempt ceiling terminal failure in Postgres and BullMQ failed set
  - Default producer queue lifecycle and fallback handling
  - Atomic claim, live 5th attempt contention, early fire, stale ownership fencing, and lease renewal
- Verification scripts (`src/jobs/scripts/`):
  - `jobs:check-valkey`: confirms connection and `noeviction` policy.
  - `jobs:prove:boxes-4-5`: proves Box 4 (immediate execution on Shard A and Shard B with measured handler timing of ~211ms) and Box 5 (delayed fire strictly after due time with consistent clock, and exponential backoff).
  - `jobs:prove:crash`: proves Box 6 (abrupt SIGKILL termination and subsequent recovery upon lease expiry).
