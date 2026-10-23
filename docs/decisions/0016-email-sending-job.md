# 0016: The email job: frozen payload, one key per row, and what a failure means

- **Status:** accepted (2026-10-23). The 10-second send timeout is a chosen ceiling, now checked against **one** real send (below); tune it when there is more than one sample
- **Date:** 2026-10-23
- **Decided by:** Dave
- **Related:** `.agents/rules/jobs.md` (External effects, Failure tests), ADR 0003 ("revisit when Resend is implemented"), ADR 0004, ADR 0015, `AGENTS.md` (Stack: Email)

## Problem

The first real worker email (invitations; reset and magic link reuse it in 2b). A request must never call Resend. The email must send once even if the queue loses the job, the
worker crashes, or Resend answers but the answer is lost. Resend's free plan is small, and a retry cannot fix every failure.

## Decision

- **Frozen payload.** The API renders the whole request (sender, reply-to, recipient, subject, HTML, text, link) once and stores it as `work_rows.payload`. A retry sends exactly
  that, never a re-render. Created in the same transaction as the invitation; `origin_request_id` records which request made it (`observability.md`).
- **One key per row.** `Idempotency-Key: email-<rowId>`, the same on every attempt and every generation. Resend keeps keys 24 hours and, for the same key and payload, returns the
  first answer without sending again (Resend docs, read 2026-10-23). A lost response is therefore safe to retry.
- **`first_attempt_at`** is written (only if null) and committed **before** the first call; recovery and rescheduling never reset it. **No automatic send after 23 hours** from it
  (one hour inside Resend's 24): the row is marked `failed` for a human.
- **Classification, in one place** (`jobs/resend.ts`). Retryable (same key, backoff): timeouts, network errors, 5xx, a per-second `429`, `409 concurrent_idempotent_requests`. Terminal
  (`failed`, no retry): `400/401/403/404/422`, `409 invalid_idempotent_request`, and **`429 daily_quota_exceeded` / `monthly_quota_exceeded`** (resets at midnight UTC or next month, so
  retrying in seconds only burns the attempt budget). A refused API key is logged at error level.
- **Terminal path in the processor.** A handler throws `TerminalJobError`; the processor marks the row `failed` with the reason on the same three-field ownership check and does **not**
  rethrow, so BullMQ never retries it and the sweeps never retry `failed` rows.
- **A dead invitation sends nothing.** Before stamping anything the job checks the invitation is still pending and its token hash is the one this email was made for. A revoked,
  replaced (resent), accepted or expired invitation's queued email is skipped: the row ends `done` with no `sent_at`, and the pending list reports that as not sent.
- **Payload scrubbing.** On success, and on a skip, the body and link are removed from the row (`payload - html - text`); the raw invite token then exists nowhere in Postgres. A row that
  ends `failed` keeps its payload for a human retry; the token alone cannot join a team (ADR 0015: acceptance is tied to the invited address).
- **Config.** The worker needs `RESEND_API_KEY` (secret, worker only) and refuses to start without it; the API needs `MAIL_FROM` and `MAIL_REPLY_TO` and refuses to start without them.
  The send timeout is **10 s**: well under the 30 s work lease so a hung call is abandoned before the lease can expire. **Measured (ADR 0003 asked for this), one real send on
  2026-10-23:** from `first_attempt_at` to `sent_at` 965 ms (that span is the lease renewal, the Resend call and the recording write), and the whole job 1,501 ms including the
  claim. One sample, from a development machine, not a distribution: it shows the call is far inside both the 10 s timeout and the 30 s lease, not what its tail looks like.
- **Resend facts used** (https://resend.com/pricing, `/docs/knowledge-base/account-quotas-and-limits`, `/docs/api-reference/rate-limit`, `/docs/dashboard/emails/idempotency-keys`,
  `/docs/api-reference/emails/send-email`; no "last updated" date on them): free plan 100 emails per UTC day and 3,000 per month, every recipient and test email counts; API 10 requests per
  second per team; `Idempotency-Key` up to 256 characters kept 24 hours; body fields `from`, `to`, `subject`, `html`, `text`, `reply_to`. **Not stated by those pages:** the error JSON
  shape and the success status code, so the client reads the error `name` defensively and the real send confirms it.
- **Tests never send real mail.** A fake Resend that honours idempotency keys stands in. The one real send, to the address in the local `PROOF_EMAIL_TO`, is a separate proof.

## Consequences

- With 5 attempts and a 2 s doubling backoff, a Resend outage longer than about 30 seconds ends the row `failed`. The Owner sees "email not sent" and can resend (a new row). A longer
  backoff for email is a config change if real outages need it; nothing is invented here.
- Free-plan headroom is shared: invites cap at 50 a day (ADR 0015) so reset and magic link keep room.
- Revisit when: a second email kind needs different retry rules, the plan changes, or the proof shows latency near the lease.

## Evidence

`server/src/jobs/email.integration.test.ts`, `email-recovery.integration.test.ts` (a lost invite email on shard B restored by the sweep), `resend.unit.test.ts`, and the real-send proof in the server PR.
