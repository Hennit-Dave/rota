---
trigger: model_decision
description: "Read before writing or changing any background job, BullMQ queue or worker, retry or failed-list logic, reconciliation or recovery sweep, scheduled work (renewals, quiet-hours delays), push notifications or email sending."
---

# Jobs, queues and recovery

If a rule here conflicts with `AGENTS.md`, stop and ask.
The failure tests at the end are the acceptance criteria; the prose alone proves nothing.

## What must be a job

- Push, email, Stripe webhook processing, renewals and slow third-party calls run as jobs, never in the
  request (the brief requires it). Exception: payment-session creation (`AGENTS.md` rule 10).

## The queue is not storage

- **Write the work row to Postgres first, then enqueue.** *Why: Aiven's free Valkey is one node with
  periodic snapshots, so queued jobs can be lost; the row is the durable fact.*
- Never change Valkey's `noeviction` policy; handle rejected writes explicitly. A Valkey failure must never
  stop a work row being recorded.
- **Destructive tests only on a disposable Valkey** (local Docker or a test queue). Never `FLUSHALL`,
  never the shared Aiven instance.

## Work rows

| Column | Meaning |
|---|---|
| `status` | `pending`, `claimed`, `done`, `failed` |
| `generation` | Increments on reschedule and on any recovery that needs a new job ID |
| `execution_attempts` | Durable count of claimed executions. Never reset by recovery or rescheduling |
| `run_at` | When the work should happen (business time). Recovery never moves it |
| `available_at` | When a timed sweep may treat the row as lost |
| `claim_token`, `claim_expires_at` | Current execution's ownership token and lease |
| `origin_request_id`, `payment_operation_id` | Correlation IDs, logged by every execution (`observability.md`) |
| `payload`, `first_attempt_at` | Email only (see below) |

## Job IDs

- Format: `work-<rowId>-<generation>`. **No `:`** — BullMQ forbids it in custom IDs.
- The job carries `generation` in its data. Re-adding the current generation's ID is safe on purpose:
  BullMQ ignores it if the job exists and restores it if it was lost.

## Ownership

Two executions of one BullMQ job can overlap, so the job ID never proves ownership. Each execution gets a
random `claim_token`. **The token proves ownership of the row. It does not by itself fence external
effects** — that is the job of the idempotency rules below.

1. **Claim** in one atomic update, only where `generation` matches the job's, `run_at <= now()`, and the
   row is `pending` or `claimed` with an expired lease. The same update sets `status='claimed'`, the token,
   `claim_expires_at = now() + lease`, and increments `execution_attempts`.
2. If no row updated:
   - `done`, `failed`, or generation mismatch → stale job; exit without effects.
   - Active claim by another token → throw a retryable error (never exit "successfully": BullMQ would mark
     the work completed). **Contention does not touch `execution_attempts`.**
   - `run_at` in the future → reschedule (see Scheduling).
3. **Every ownership update** — lease renewal, release, completion, final failure — matches all three:
   `status='claimed' AND generation = <job's> AND claim_token = <mine>`. Zero rows updated means ownership
   is lost: abort, change nothing else.
4. **Renew the lease immediately before each external call**; abort if it fails. This cannot cancel a call
   already in flight; the idempotency rules must make such a call harmless.
5. **Retryable failure:** release (`status='pending'`, token and lease cleared, matched as in 3), rethrow.
6. Lease length is config, longer than the slowest job, justified in an ADR. Never invent a value.

## Attempt budget

- `execution_attempts` increments only on a successful claim, so crashes after claiming count and
  contention does not. Max is config.
- **A claim that would exceed the max** marks the row `failed` (reason: attempt budget exhausted) instead
  of running. **A failing execution at the max** marks it `failed`, matched as in Ownership rule 3.
- BullMQ `attempts` only paces retries with backoff. The durable count decides `failed`, so queue loss and
  new generations never grant a fresh budget.
- **Human retry only:** an explicit admin action sets `status='pending'`, resets `execution_attempts` to 0,
  increments `generation`, sets `available_at = now()`, logs who and why, and enqueues the new job ID.
  Sweeps never retry `failed` rows.

## Scheduling: never run early, never keep an old schedule

- Every enqueue uses `delay = max(0, run_at − now)`, including recovery re-adds.
- **Job fires early:** it cannot have claimed (claims require `run_at <= now()`). Call
  `job.moveToDelayed(<run_at>, token)` with the **BullMQ lock token** the processor receives, then throw
  `DelayedError`. *Why: re-adding an existing ID does nothing; this moves the same job without
  using a BullMQ attempt.*
- **Rescheduled from outside** (quiet hours changed, renewal moved), **only for rows that are `pending` or
  `claimed`**, in one transaction: update `run_at`, increment `generation`, **clear any active claim** (`status='pending'`, token and lease null), reset
  `available_at`. Then enqueue `work-<rowId>-<newGeneration>`. A running old execution fails its next
  ownership update (rule 3) and aborts before its next external call. Updating `run_at` alone is never
  enough. `done` rows stay done; `failed` rows need the admin retry action. If the update changes 0 rows,
  log it and enqueue nothing.
- Quiet-hours jobs re-check the user's current settings and time zone when they run.
- `available_at = run_at + 2 minutes`, or `now()` when an enqueue explicitly failed.

## Recovery triggers

| Trigger | Action |
|---|---|
| Enqueue fails inside a request | Row stays `pending`, `available_at = now()`; the request still succeeds |
| Worker startup, Valkey reconnect | Check every `pending` row's current job (see below) |
| Stripe redelivers a recorded, unprocessed event | Re-enqueue; skip only *processed* events |
| Timed sweep, every 30 minutes | `pending` rows past `available_at` (checked as below), and `claimed` rows with an expired lease |

**Checking a pending row's job.** Look up `work-<rowId>-<generation>` in BullMQ and act on its state:
- Missing → add it with the remaining delay.
- Waiting, delayed or active → leave it.
- **Failed or completed** (BullMQ's own retries ran out, or a completion update was lost) → re-adding
  that ID does nothing, so start a **new generation**: bump `generation`, keep `execution_attempts`,
  enqueue the new ID. The durable budget still decides `failed`.
- Expired-claim recovery bumps `generation` and clears the claim in one transaction.
- The timed sweep picks its batch with `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction. That lock
  protects only the pick. **No session-level advisory locks** — Neon's transaction-mode pooler doesn't
  support them.
- Sweeps run on a process-level timer in the worker, independent of BullMQ.

**30 minutes is a proposed demo trade-off, not a brief requirement.** Each sweep wakes the Neon primary
for at least 5 minutes; Free gives 100 CU-hours per project across all computes:
730 × 5/30 × 0.25 ≈ 30 CU-hours per primary. A 10-minute timer is ≈ 91. Health checks never touch Postgres.

| Case (services up) | Recovery delay |
|---|---|
| Normal path | Seconds, plus backoff |
| Enqueue failed, or Valkey reconnected | Seconds after reconnect |
| Worker crashed mid-job | Up to the lease + up to 30 min + queue wait + processing |
| Silent queue loss, no disconnect seen | Up to 2 min + 30 min + queue wait + processing (≈ 32 min or more) |
| Repeated or long outages | No upper bound while services are down |

Log every execution: job ID, row ID, generation, attempts, outcome, duration.

## External effects must be safe to repeat

- **Ledger:** unique `(operation_id, entry_type, sequence)` (`money.md`); webhook events are deduplicated
  separately in the inbox. Neither stops a customer being charged twice.
- **Stripe charges:** every charge-creation call (renewals included) uses a stable idempotency key tied to
  the logical payment operation (e.g. `charge-<paymentOperationId>`), never the generation or execution
  attempt. The payment-operation row is written first; store the PaymentIntent ID as soon as Stripe
  returns it. **After an uncertain result** (timeout, network error, crash), look up the existing payment
  before creating another. Verify Stripe's key retention window before relying on it; never invent it.
- **Email:**
  - The full request (recipient, sender, reply-to, subject, rendered body, any link) is stored as
    `payload` when the row is created. Retries send exactly that payload.
  - Idempotency key `email-<rowId>`, identical on every attempt and generation.
  - `first_attempt_at` is written and committed **before the first Resend call**, only if null. Retries,
    recovery and rescheduling never reset it.
  - On success record `sent_at` and the Resend message ID; a row with `sent_at` never sends again.
  - Resend keeps keys for 24 hours, so **no automatic send once 23 hours have passed since
    `first_attempt_at`**: mark the row `failed` for a human.
  - Changed content or a new invite token is a **new logical email: a new row**, never an edit.
- **Push:** `notification_deliveries`, unique on `(notification_id, device_token_id)`, states `sending`,
  `sent`, `failed`.
  - Claim the row as `sending` with a token and `sending_started_at` before calling Expo; set `sent` and
    the ticket ID after. Retries skip `sent` devices.
  - A `sending` row older than the push timeout (config) is reclaimed and resent, logged as
    **"possible duplicate"**: the earlier send's outcome is unknown.
  - This is **at-least-once processing attempts, not guaranteed delivery**: an accepted Expo ticket doesn't
    prove the device received it. Receipts are checked in their own job; `DeviceNotRegistered` deletes
    the token.

## Failure tests (acceptance criteria; disposable Valkey and test database)

Each asserts rows and logs, not just "no error".

1. **Retry reacquires:** claim, throw retryable → released → retry claims; effect once.
2. **Overlap:** two concurrent executions of one job ID → exactly one claims; one effect.
3. **Stale execution fenced:** A claims; lease expires; sweep bumps `generation`; B completes. A's
   renewal, completion and failure updates change 0 rows.
4. **Reschedule after claim:** A claims; quiet hours change (generation bumps, claim cleared). A's next
   renewal fails, it makes no further external call, and the new generation runs at the new time.
5. **Early fire:** a job before `run_at` → moved to delayed; nothing claimed before `run_at`; it claims
   the row when it runs.
6. **Queue loss preserves schedule:** delete a delayed job, restart the worker → restored with its
   remaining delay; not run early.
7. **Enqueue failure:** fails in a request → row eligible at once → reconnect sweep enqueues it.
8. **Timed sweep:** a pending row with no trigger is restored on the next sweep; logs show the delay.
9. **Attempt budget:** repeated crashes after claim plus recovery → `failed` at the max, across
   generations; contention retries leave `execution_attempts` unchanged; a human retry resets it.
10. **Email:** same key and stored payload on every attempt; `first_attempt_at` unchanged by recovery; a
    row past 23 hours is `failed` with nothing sent.
11. **Push reclaim:** stop after `sending` → reclaimed after the timeout, logged "possible duplicate";
    `sent` rows skipped.
12. **Stripe redelivery:** recorded-unprocessed is re-enqueued; processed is skipped.
13. **BullMQ-failed job recovered:** exhaust a job's BullMQ retries while the row still has budget →
    the sweep sees the failed job, starts a new generation, and `execution_attempts` carries over.
14. **Stripe uncertain result:** a charge call times out after Stripe received it → the retry finds
    the existing payment; no second charge.
15. **Reschedule finished work:** rescheduling a `done` or `failed` row changes nothing and enqueues nothing.
