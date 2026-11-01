# 0030: A saved card and the consent to charge it later (slice P6a)

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-11-01
- **Decided by:** Dave (P6 answers and the P6a plan, 2026-11-01: option A, the two wording changes, "until you cancel" means removing the card, the additive migration). The choices below that the plan did not spell out were made while building and are marked **new**.
- **Related:** `.agents/rules/money.md` ("Renewals and failed renewals"), `AGENTS.md` rules 5, 7, 9, 10, 13, ADR 0026 (schema), ADR 0027 (activation, webhook, job), the `webhook-handler` skill

## Problem

Renewals (P6b) charge a card with nobody present. Checkout as built in P3 takes one payment and forgets the card. Stripe can only charge a card later if three things exist: a **Customer** (Stripe's record of the buyer), a **PaymentMethod** (the saved card, attached to that Customer) and the buyer's **agreement** to future charges. P6a saves the card and records the agreement. It charges nothing, writes no ledger row and renews nothing.

## Options considered

1. **Setup mode only** (a separate "add a card" Checkout for everyone). Less change to the payment path, but a new team goes through two Stripe pages. Rejected.
2. **Save the card at activation, and add a setup-mode flow for teams that already paid and for failed-renewal recovery.** One consent, on the same page as the first payment. **Chosen** (Dave, 2026-11-01).
3. **Create the Stripe Customer ourselves, first.** A second synchronous Stripe call: rule 10 allows exactly one (the session). Rejected. Checkout makes the Customer (`customer_creation: 'always'`) and we pass it back when the team already has one.

## Decision

**Activation saves the card.** `payment_intent_data.setup_future_usage: 'off_session'`, the consent wording in `custom_text.submit.message` (beside the pay button), and `customer_creation: 'always'` (or the team's existing `customer`). The wording is frozen on `payment_operations.consent_wording` when the operation is created, so a retry sends identical parameters (Stripe refuses a reused idempotency key with different parameters) and the stored consent is the consent that was displayed. A paid change (P4) is unchanged: no card, no wording (unit test).

**Setup mode.** `POST /teams/:id/billing/card/setup` (Owner only, `Idempotency-Key`, no body, the billing rate limit). In one transaction under the team row lock it freezes a `card_setups` row (the consent wording, the monthly amount in cents and the anchor day, all from the team's own subscription) and the `payment_requests` row for the key, **before** Stripe is called; then the one bounded call (`mode: 'setup'`, key `setup-<id>`). Same key, same request: the stored answer. Another key while one is open: 409. A key that belonged to another request: 422. An uncertain Stripe result leaves the setup open and the same key resumes it; a definite refusal closes it as `failed`. Nothing about the outcome is recorded here.

**Who decides that a card was saved: the verified webhook and the job, never the app.** The webhook route accepts setup sessions (`checkout.session.completed` and `.expired`; metadata `team_id` + `card_setup_id`) next to payment sessions, records them on the same shard A inbox, and enqueues the same `stripe_event` work row; the payload carries `purpose: 'card_setup'` so a row recorded before P6a is still read as a payment. The job matches the event to the frozen setup (same team, still open, same session, a setup-mode session) and then **reads the SetupIntent from Stripe, outside any database transaction**. It records a card only if the intent `succeeded`, was made for off-session use, is a `card`, has a Customer equal to the session's, was made in test mode, and carries our `team_id` and `card_setup_id`. Anything else sends the setup to review with a reason and records nothing. Then one team-shard transaction (under the team row lock) marks the old active card `replaced`, inserts the new one with its consent and marks the setup `completed`; only afterwards is the inbox row marked processed (a crash between the two is safe: the replay finds the card and finishes the inbox). A card on a Stripe Customer other than the team's, or one already recorded for another team, is refused.

**The activation card is saved after the payment, and never undoes it.** After the existing apply step (applied or replayed), the job reads the PaymentIntent, runs the same matching and records the card with `source = 'activation'`. A card problem is logged (`CARD_NOT_SAVED`) and the payment stands: the team simply has no saved card and follows the failed-renewal path (Dave's P6 answer 3). An unknown Stripe outcome throws, so the job retries; the replay sees the payment as already applied and still runs the card step.

**What is stored.** `team_payment_methods`: Stripe's Customer and PaymentMethod ids, brand, last four, expiry, the consent wording, the amount in cents and the anchor day it named, and when. We never see a card number. One active card per team (a partial unique index); the same Stripe card is never saved twice (unique). Rows are never deleted; status is the only column that changes. The app is shown finished strings only ("Visa ending 4242", "Expires 08/2031", the wording, the UTC date) and **never a Stripe id**.

**Removing the card** (`DELETE /teams/:id/billing/card`, Owner only) marks it `removed`: "until you remove this card" in the wording means exactly this, because the brief has no subscription cancellation. We never charge a card that is not `active`.

**Wording** (Dave, 2026-11-01, built in `consent.ts`, made only on the server): *"By paying, you authorise Rota to charge this card the monthly price of your plan and seats, currently [amount], on day [N] of each month until you remove this card. Test mode only."* The add-card variant starts *"By saving this card, you authorise…"* (nothing is paid when a card is only saved). Days 29 to 31 add *"(the last day in shorter months)"*, because the period then ends on the month's last day (money.md). The amount is the engine's monthly price; the day is the billing anchor day, a **UTC** calendar day (the app shows "agreed on <date> (UTC)").

## New choices (made while building)

1. **The worker now holds the Stripe test key (new; supersedes "the worker holds no Stripe key", ADR 0027).** The job needs to *read* the SetupIntent or PaymentIntent. The worker gets only `STRIPE_SECRET_KEY` and `STRIPE_TIMEOUT_MS` (`loadStripeApiConfig`), never the webhook signing secret, and refuses to start with anything but an `sk_test_` key. It creates nothing on Stripe. Alternative considered: carry the card details on a `payment_method.attached` event, which needs a Customer-to-team mapping we only get from the session event, so the two events would race. Rejected.
2. **`stripe_events` gets no new column (new).** A setup event stores `team_id` and its session id; the setup's own id travels in the work row payload. "Confirming" is "an unprocessed event exists for this setup's session".
3. **A card Stripe cannot attach is never recorded (new).** Stripe's testing page says issuer-decline cards (for example 4000 0000 0000 0002) cannot be attached to a Customer. Tested with no event at all: the setup stays open until it expires.
4. **A card saved on a Checkout we had already closed is recorded for review, never silently kept (new).** Cancelling ends our setup; Stripe's session lives to its own expiry (at most 31 minutes, as in ADR 0027 choice 3). If the buyer finishes it, the setup goes to `needs_review` (`completed_after_expired`) and no card is recorded.
5. **The removed card stays attached to the Customer on Stripe's side (new).** Detaching is a second Stripe call; what we may charge is decided by our table. A later slice can detach in a job.
6. **An activation made before P6a** (no consent wording on its operation) is applied exactly as before and no card is read.
7. **Deploy note (new).** Changing the Checkout parameters changes the request behind a stable key `op-<operationId>`. An operation created before the deploy and resumed after it would be sent with the new parameters and Stripe would refuse the reused key. Only a window of at most 31 minutes, and only for an open activation; deploy when none is open.
8. **All values are chosen, not measured:** the lifetime of a setup is the activation operation's (31 minutes); the status screen polls every 3 seconds (`OPERATION_POLL_MS`); the billing rate limit is the one from ADR 0027.

## What Stripe's documentation did and did not say

Verified from Stripe's docs on 2026-11-01 (the fetch tool summarised some long pages; those items are marked): `setup_future_usage: 'off_session'` on the PaymentIntent saves the card, and Checkout attaches it only to a passed or created Customer; in setup mode the PaymentMethod is on the SetupIntent, not on the Session; a setup-mode Session has `payment_status: 'no_payment_required'` (so the payment job's "only `paid`" rule can never apply to it, and setup needs its own branch); `custom_text.submit.message` allows 1200 characters; idempotency keys may be removed once they are at least 24 hours old; card 4000 0000 0000 0341 attaches and then declines when charged (P6b's failure card). **Not stated, so proved in the sandbox** (below): (1) whether `custom_text` is shown in setup mode, (2) whether the Session's `customer` is filled in the completed event when `customer_creation` is `always`, (3) whether the SetupIntent's `payment_method` can be expanded on retrieve and its `usage` reads `off_session`. Session metadata is **not documented as copied** to the SetupIntent, so it is set on both.

### Sandbox answers (to be recorded from the P6a proof run)

1. `custom_text` in setup mode: _pending the proof run_
2. `customer` on the completed event with `customer_creation: 'always'`: _pending the proof run_
3. `payment_method` expansion and `usage` on a setup-mode SetupIntent: _pending the proof run_

## Consequences and limits

- **Not built here:** charging the card, grace, read-only access, applying a reduction, notifications (P6b and the push slice); detaching the card at Stripe; saving a card from a paid *change*.
- A team that never saved a card (every P3 team, and any team whose card step failed) can renew only through the failed-renewal path. P6b builds it.
- No money is calculated in the app and none moves in this slice: the amount in the wording is the engine's, as cents, formatted on the server; no ledger row is written (tested).
- Migration `20261101100000_add_saved_card_and_consent` is additive (two tables, one nullable column), applied to the **test** shards first; the real shards on Dave's go.
- **Revisit** if Stripe starts showing a second, conflicting consent text in setup mode, or if detaching removed cards becomes a requirement.

## Evidence

See the PR description: the integration tests (setup, activation, replays, mismatches, review, removal, the database indexes) on both test shards, the unit tests (wording, the Stripe requests), the app tests, and the sandbox proofs.
