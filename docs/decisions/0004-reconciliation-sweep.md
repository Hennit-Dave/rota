# 0004: Reconciliation sweep, and a cap on pre-claim recoveries

- **Status:** proposed (accepted when Dave merges the PR)
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** issue #13 (Refs), `.agents/rules/jobs.md`, ADR 0003, `server/src/jobs/reconcile.ts`

## Problem

Valkey on Aiven's free plan is one node, so queued jobs can be lost. Postgres work rows are the record, so
something independent of BullMQ has to notice a row that should have a live job and doesn't, and restore it.

Designing that sweep exposed a gap in `jobs.md`. A pending row whose BullMQ job has failed gets a new
generation, and the rule said "the durable budget still decides `failed`". But `execution_attempts` only
increments on a successful **claim**. A job that fails *before* claiming (Postgres unreachable at the claim
query, a bug in the claim path) never spends any budget. BullMQ retries it 5 times, marks it failed, the
sweep starts a new generation, and it repeats every sweep forever, waking Neon each time and leaving one more
failed job in Valkey.

## Options considered

1. **Count claims only (the rule as written).** No schema change. Does not stop a job that never claims.
2. **Cap the generation number.** No new column, but `generation` also increments on reschedules (quiet
   hours, moved renewals), so a cap would eventually block legitimate rescheduling.
3. **Store a counter in `failure_reason` or similar.** Hides a number in a text field; unreviewable.
4. **A dedicated `recovery_count` column.** One additive integer: how many times in a row the sweep has had
   to replace a failed job for this row without any claim in between.

## Decision

1. The sweep runs at worker startup, on a timer (`RECONCILE_INTERVAL_MS`, 30 minutes), and after a Valkey
   reconnect, in batches of `RECONCILE_BATCH_SIZE` (100), picked with `FOR UPDATE SKIP LOCKED`. The lock
   protects only the pick; all Valkey calls happen after commit. Sweeps never overlap.
2. Add `work_rows.recovery_count INTEGER NOT NULL DEFAULT 0` (option 4), applied to shard A, shard B and both
   test shards.
   - Incremented in the same statement as the generation bump, only when the cause is "BullMQ job failed or
     completed while the row is still pending".
   - Reset to 0 inside the claim `UPDATE`: a successful claim proves the path works.
   - Expired-claim recovery leaves it alone; `execution_attempts` already bounds that path.
   - At `WORK_MAX_RECOVERIES` the sweep marks the row `failed`, reason
     `unclaimable_after_recoveries: <sanitized BullMQ failure reason>`. Sweeps never retry `failed` rows;
     a human retry is the only way back.
3. `WORK_MAX_RECOVERIES` is its own setting, defaulting to `WORK_MAX_ATTEMPTS` (5). No new number was
   invented. With a 30-minute sweep that is about 2.5 hours of outage before a human has to look.
4. `jobs.md` is amended in the same PR: the new column, the rule above, and failure test 16.

## Why

- A counter on the row is durable (it survives queue loss and restarts) and is visible in SQL, which is how
  the other budgets are inspected.
- Resetting on claim makes it a count of *consecutive* fruitless recoveries, so a row that is healthy between
  incidents is never penalised for old ones.
- Both updates are conditional on the generation and `pending` status the sweep saw, so two racing sweeps
  change the row once.

## Consequences

- **Easier:** a poisoned row ends in `failed` with a reason instead of costing a Neon wake-up forever.
- **Harder or given up:** an outage longer than the cap times the sweep interval fails rows that a human must
  retry. Raising `WORK_MAX_RECOVERIES` trades that for more resurrection attempts.
- **Known limits:** the human-retry action does not exist yet (no admin surface), so `failed` rows stay failed.
  Valkey retention of failed jobs is addressed separately in this PR's retention work.
- **Revisit when:** the human-retry action is built (it must reset `recovery_count` with `execution_attempts`),
  or the sweep interval changes.

## Evidence

- `server/src/jobs/reconcile.integration.test.ts`: a job that keeps failing before claim ends `failed` at the
  cap with no generation beyond it; a claim resets the counter; attempts carry across generations; Valkey
  failure after a bump keeps the bump and makes the row eligible.
- Stage 2 (queue-loss proof on local Valkey) and stage 3 (email) add their own evidence below when done.
