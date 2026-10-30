# 0028: Plan and seat changes: quotes, immediate and paid changes, and the billing history

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-30
- **Decided by:** Dave (P4 + P5 plan, five recommendations accepted 2026-10-30: reductions stop at the period boundary check and P6 applies them; inactive members are non-members and not a seat; the Owner's notice before the boundary waits for the push slice; a change after a period has ended is refused until P6; one branch with P4 then P5 as separate commits, a pause after P4's tests)
- **Related:** `.agents/rules/money.md`, `AGENTS.md` rules 1, 2, 3, 6, 7, 8, 10, ADR 0026 (engine and schema), ADR 0027 (activation), the `money-and-proration` and `webhook-handler` skills

## Problem

An Owner whose team has activated must be able to add seats or move to a higher plan, see exactly what it costs before agreeing, and trust that the ledger records it. The charge is the highest-risk number in the app, so none of it may be calculated anywhere but the engine from ADR 0026.

## Options considered

1. **A separate payment path for changes.** Duplicates the idempotency, freezing and Checkout code. Rejected.
2. **Reuse activation's machinery (`checkout.ts`), add a `change` operation kind.** The same Idempotency-Key handling, the same one bounded Stripe call, the same webhook and job. **Chosen.**
3. **Let Stripe prorate.** Forbidden by `AGENTS.md` rule 6.

## Decision

**Quote (`GET /teams/:id/billing/change-quote?plan=&seats=`, Owner only, read-only).** Loads the subscription and its current period from the primary, asks `quoteChange` (the engine, unchanged) and answers in finished text: when it takes effect (`now`, `after_payment`, `at_period_end`, `mixed`), `supported`, the charge today, the next renewal, the days left, the period end, and the server's own sentence. The plan said `POST /quotes`; I used a `GET` with a query, like the activation quote, because it has no side effect and the app already has that pattern.

**Change (`POST .../changes`, Idempotency-Key, body `{ plan, seats }` and nothing else).** Under the team row lock, against the state the database holds now:
- **Needs no payment** (seats inside the allowance, a cheaper upgrade, or a charge under Stripe's $0.50 minimum): applied in this one transaction with a fresh operation id, one `entitlement_change` ledger row, the subscription updated and its version raised. The answer is `{ status: 'applied', change }`.
- **Paid:** frozen as a `change` payment operation (base version, period, from and to, the whole calculation) and sent to Checkout. The answer is `{ status: 'payment_required', operation, checkoutUrl }`. Activation's answer now carries the same `status`.
- **While a payment is open, every other change is 409**, the free ones too: they would change what the payment was quoted against.
- **Refused:** the same plan and seats (400 `nothing_to_change`); a team with no subscription (409 `not_activated`); anything with a decrease (409 `scheduled_change_unavailable`, until P5); a change at or after the end of the period (409 `period_ended`, until P6 starts the next one); a paid change in the last 31 minutes of a period (409 `period_ending`).

**Applying a paid change (the `stripe_event` job).** The same matching as activation (amount, currency, team, session, `paid`), then, in one team-shard transaction under the team and subscription row locks: **the subscription version must equal the operation's base version** (a mismatch NEVER applies: recorded, sent to review), the period and the base plan and seats must be unchanged, and **our own engine re-derives the charge from the frozen inputs** and must equal the quote, the credit and the paid-basis-after. Then the credit, the charge and the entitlement change are written, the subscription's plan, seats and paid basis are updated and its version raised, and the operation completes. Credit plus charge is the payment, as money.md says.

**Billing history (`GET .../history`).** Read from the ledger (rule 8), newest first, grouped by operation: date, title ("Subscription activated", "Plan or seats changed"), what the team had after it, the net as "+$3.60" or "No charge", and the credit and charge lines. One answer holds at most 50 operations (`HISTORY_PAGE_SIZE`, chosen, not measured) and says `hasMore`.

**Overview** carries the open payment, so the hub shows it instead of offering a second change.

**App.** The hub ("Plan & billing") replaces the old summary, with "Change plan or seats" and "Billing history". The change screen shows the server's quote and sentence and offers "Apply change" or "Continue to payment" only when the server says `supported`. A paid change goes through the same Stripe page and the same status screen (worded for a change). No native build.

## Choices worth knowing (chosen, not measured, unless said)

1. **The cut-off is 31 minutes, not 30.** Decision 5 said "the last 30 minutes of a period"; the reason was that an operation cannot be applied across a boundary. A payment operation lasts 31 minutes (ADR 0027, choice 1), so a 30-minute cut-off would let one outlive its period by a minute. `PAID_CHANGE_CUTOFF_MS` is the operation's own lifetime.
2. **A free change is not blocked by the cut-off.** It costs nothing and cannot straddle a payment.
3. **The credit and the charge both carry the payment id** (the state row does not).
4. **No schema change in P4.** `payment_operations` already had the kind, the base version, the period and the whole calculation. P5 adds `scheduled_changes` and `memberships.deactivated_at` (approved).

## Consequences and limits

- **Not in P4:** reductions and mixed changes (P5), applying a scheduled change and renewing (P6).
- **A change after the period has ended is refused** until the renewal exists to start the next period; every team passes its period end, so P6 is what makes this stop being a dead end.
- **Test hygiene found on the way:** the P3 integration tests used fixed payment ids; operations and ledger rows can never be deleted, so a second run on the same test shard collided with the first run's rows and sent valid activations to review. Payment ids are now unique per run in both integration files.

## Evidence

See the PR description: the tests (15 change integration tests on both test shards, 8 unit tests, 10 app tests; the 33 activation and seat tests still pass), and the real Stripe sandbox run of Team 15 to 18 seats with 12 days left, which is $3.60.
