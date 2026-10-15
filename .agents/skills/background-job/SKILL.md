---
name: background-job
description: Procedure for adding or changing a Rota background job - the Postgres work row, enqueueing with the right job ID and delay, claiming with a per-execution token, scheduling, idempotent external effects, recovery sweeps and the failure tests. Use for any BullMQ job, including email, push, webhook processing and renewals.
---

# Background job

Every rule this procedure follows is in `.agents/rules/jobs.md` (path from the repo root): read it first.
Correlation and logging are in `observability.md`; email and push duplicate protection is in `jobs.md`'s
external-effects section.

## Steps

1. **Decide it must be a job** (`jobs.md`, "What must be a job"). Payment-session creation is the one
   exception and is not a job.
2. **Define the work row** with every column the work-rows table in `jobs.md` lists, plus anything the job
   needs (for email: the frozen `payload`). Add a migration (`data.md`: both shards).
3. **Request path:** in the same transaction as the business write, insert the work row with `run_at`,
   `available_at`, `generation`, and the correlation IDs. **After commit**, enqueue with the job ID format
   and delay rule from `jobs.md`. If enqueueing fails, mark the row immediately eligible and still return
   success.
4. **Processor:**
   1. generate a fresh claim token;
   2. claim atomically, exactly as `jobs.md` specifies, then branch on why a claim failed (stale, held by
      another token, too early);
   3. too early → move the job to delayed with BullMQ's own transition, never a re-add of the same ID;
   4. renew the lease right before each external call; abort if renewal fails;
   5. make the external effect idempotent (`jobs.md`);
   6. finish with a token-matched update to `done`; on a retryable error, release then rethrow; at the
      attempt budget, mark `failed`.
5. **Scheduled work** sets `run_at` to the business time; external reschedules follow `jobs.md` (bump
   generation, clear the claim, enqueue the new ID).
6. **Recovery:** confirm the new row type is covered by the startup, reconnect and timed sweeps, including
   the check for jobs BullMQ already marked failed or completed.
7. **Logging:** every execution logs the fields `observability.md` lists, read from the row.
8. **Tests:** the failure tests in `jobs.md` that apply, run against disposable Valkey and a test database.

## Worked example: invite email

- Inviting a member writes the invite (team shard) and an email work row with the frozen payload
  (recipient, subject, rendered body with the link) in one transaction, then enqueues
  `work-<rowId>-<generation>` after commit.
- The processor claims with its own token, writes `first_attempt_at` if empty and commits it, renews the
  lease, sends through Resend with the stable idempotency key, records `sent_at` and the message ID, and
  completes with a token-matched update.
- Tests: retry reacquires and sends once; a lost queued job is restored by the sweep with its correlation
  IDs; a row past the email window is `failed` with nothing sent.

## Common mistakes

- Enqueueing before the transaction commits, or without a work row.
- A `:` in a custom job ID.
- Using the job ID as the ownership proof.
- Exiting "successfully" when another execution holds the claim.
- Re-adding an existing job ID and expecting it to run again.
- Rescheduling by updating `run_at` alone instead of the new-generation transaction in `jobs.md`.
- Resetting `first_attempt_at` or `execution_attempts` during recovery.
- Session-level advisory locks through the pooler.
- Running destructive tests against the shared Aiven instance.
