---
name: webhook-handler
description: Procedure for receiving and processing Stripe webhooks in Rota - raw-body signature verification, the shard A inbox, duplicate handling, the processing job, payment matching and the team-shard transaction. Use when adding, changing or testing anything on the webhook path.
---

# Stripe webhook handler

Rules: `AGENTS.md` rule 7, `.agents/rules/money.md` (webhooks and payment confirmation),
`.agents/rules/security.md` (pipeline table), `.agents/rules/jobs.md`, `.agents/rules/observability.md`.
Paths are from the repo root. This is the payment path: get Dave's "go" first.

## Steps — the request

1. **Mount order:** the webhook route uses `express.raw({ type: 'application/json' })` and is registered
   **before** any global `express.json()`.
2. **Verify the signature against the raw body** with Stripe's own verification helper and the webhook
   signing secret from env. Check Stripe's current docs for the helper's name and arguments; don't guess.
3. **Before verification succeeds, log only** the request ID and the outcome (`observability.md`). An
   invalid signature → reject without parsing anything.
4. **After verification:** validate the event with Zod; log event ID and type.
5. **Record in the shard A inbox**, keyed by Stripe's event ID (unique):
   - new → insert, enqueue the processing job (work row first, `jobs.md`);
   - exists and **processed** → acknowledge, do nothing;
   - exists and **unprocessed** → re-enqueue.
6. **Acknowledge** with a 2xx. No business processing happens in the request.

## Steps — the processing job

7. Claim the work row (`background-job` skill).
8. Resolve the payment operation and team from the event's metadata, then route to that team's shard.
9. **Already applied?** If an operation already records this provider payment ID, finish as a no-op. If the
   operation is complete under a different payment ID, record and send to review (`money.md`).
10. **Match every field `money.md` lists** (operation open, team, frozen amount, currency, successful
    payment status, including Checkout's `payment_status`). Any mismatch → record, don't apply, review.
11. **One team-shard transaction:** ledger rows, subscription update with version check, payment ID stored,
    operation completed.
12. **Then** mark the shard A inbox row processed. A crash between 11 and 12 is recovered by replay, which
    finds the operation complete.

## Worked example: Checkout completes for an upgrade

`checkout.session.completed` arrives → signature verified → inbox row inserted → job enqueued → 2xx.
The job finds the operation from metadata, confirms nothing has applied this payment yet, checks team,
amount, currency and `payment_status = paid`, then applies the upgrade in one transaction and marks the
inbox processed. When `payment_intent.succeeded` arrives for the same payment, step 9 makes it a no-op.

**Local testing:** the Stripe CLI can forward test events to a local server and trigger them; check its
current docs for the commands. Test-mode keys only.

## Tests (from the rules)

Invalid signature rejected before parsing, nothing recorded · replayed event → one set of ledger rows ·
two events for one payment → one application · unpaid `complete` session → not applied · wrong amount,
currency or team → review · crash after the shard transaction → replay only completes the inbox · logs
before verification contain no event fields.

## Common mistakes

- `express.json()` running first, so the raw body is gone and verification fails or is skipped.
- Logging or parsing the body before verification.
- Treating a valid signature as proof the change was paid for.
- Deduplicating business effects by event ID alone.
- Doing the processing inside the request.
- Marking the inbox processed before the team-shard transaction commits.
