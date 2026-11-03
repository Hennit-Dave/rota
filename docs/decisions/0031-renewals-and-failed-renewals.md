# 0031: Renewals and failed renewals (slice P6b)

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-11-01
- **Decided by:** Dave (P6 answers and the P6b plan, 2026-11-01): a grace period of 7 days, no automatic retries, a team with no saved card follows the failed-renewal path, in-app banners now and push later, one pull request, a late payment keeps the original boundary, an Owner "Retry payment" button, an additive migration, an email to the Owner now, and a guard on **every** non-billing write. Choices the plan did not spell out were made while building and are marked **new**.
- **Related:** `.agents/rules/money.md` ("Renewals and failed renewals"), `.agents/rules/jobs.md`, `AGENTS.md` rules 1, 2, 6 to 11 and 13, ADR 0026 (schema, ledger), ADR 0027 (webhook, job), ADR 0029 (reductions), ADR 0030 (saved card), the `money-and-proration`, `background-job` and `webhook-handler` skills

## Problem

When a team's period ends it must be charged for the next one, with nobody present, using the card saved in P6a. If the charge fails the team gets a grace period, then loses write access. This is the first time Rota moves money on its own, so every step has to be safe to repeat, decided by a verified event, and rebuildable from the ledger.

## How a test-mode renewal collects money

1. **What exists already (P6a):** the Stripe Customer, the saved card (PaymentMethod) and the Owner's recorded consent to "charge this card the monthly price ... on day N of each month until you remove this card".
2. **The charge:** the worker creates one **PaymentIntent** for the amount our own engine calculated, with `off_session: true` and `confirm: true`, the team's Customer and saved card, and an idempotency key `renewal-<renewalId>-<attempt>`. Stripe only collects. No Stripe Subscription, no quantity change.
3. **The outcome:** only the **verified webhook** (`payment_intent.succeeded` or `payment_intent.payment_failed`) decides. Stripe's synchronous answer, even a decline, is used only to remember the PaymentIntent's id.
4. **Customer action:** none when it works. If the bank wants the customer present, the charge fails with `authentication_required`, because nobody is there to authenticate; the Owner must replace the card or ask the bank. What the 3-D Secure test cards really do is in "Sandbox results" below (it is **not** what I first assumed).

## Options considered

1. **Reuse `payment_operations` for renewals.** Rejected: its `kind_shape` CHECK and the "one open per team" index are about Checkout, and adding the enum value and using it in the same migration is refused by PostgreSQL ("unsafe use of new enum value").
2. **A new table, one row per team per period.** **Chosen.** `renewals` is the durable record of the renewal, of its attempt and of a failure. Its id is the ledger's `operation_id`, so the ledger still rebuilds the subscription.
3. **A flag on `subscriptions` for "past due".** Rejected: a flag can drift from the facts. "Past due" and "read-only" are **derived** from the renewal row at the moment of asking.
4. **Charge in the request when the Owner presses Retry.** Rejected: rule 10 allows one synchronous provider call, the payment session. Retry writes a request and a work row; the worker charges.
5. **Decide from Stripe's answer to the charge call.** Rejected: rule 7. A decline arrives as a verified webhook like everything else.

## Decision

**Scheduling.** `scheduleRenewal` writes the `renewals` row (unique per team and period) and its `renewal` work row (`run_at` = 00:00 UTC on the period's end date) in the same transaction as the thing that started the period: the activation (stripeEventJob) and the previous renewal. The worker also runs `ensureRenewals` at start-up, which adds a renewal to any subscription that has none (one that activated before P6b). It is idempotent and only adds.

**The job** (`billing/renewal.ts`). One transaction under the team lock freezes the attempt: the subscription version, the entitlements the new period will have, the scheduled change it applies, the monthly amount from `monthlyCents` (our engine), and the attempt number. Then, after that commits, one bounded Stripe call. A crash after the freeze is safe: a replay finds the attempt frozen and repeats the call with the **same key**, which makes Stripe return the payment it already made. An attempt older than 23 hours is **not** repeated (Stripe keeps keys for at least 24 hours and a repeat might charge twice); it fails for a human as `charge_unconfirmed`. After the attempt budget with the answer still unknown it fails the same way, and a payment that did go through is still accepted from its webhook.

**Scheduled changes first** (money.md). Inside the same transaction the job re-checks the team's scheduled reduction against the members as they are **now** (the authoritative check; it records what it found, as the boundary job does):

| The check finds | The renewal |
|---|---|
| it fits | charges the **smaller** plan's amount; the chosen people are made inactive and the change is marked `applied` **only when the payment is confirmed** |
| it does not fit and the Owner accepted the old price | charges the **current** plan; the change stays `continuing` |
| it does not fit and nothing was accepted | **no charge**, collection pauses, the team follows the failed-renewal path (`reduction_blocked`); the old, higher price is never charged silently |

**The webhook** accepts `payment_intent.succeeded` and `.payment_failed` **only** when the metadata carries our `team_id`, `renewal_id` and `attempt`; the PaymentIntents that Checkout makes for an activation or a paid change send these events too and are acknowledged and ignored (their Checkout events already are handled). Recorded on the shard A inbox, deduplicated by event id, then a `stripe_event` job (`purpose: renewal_payment`).

**Success** is applied in one team-shard transaction after every field matches what the attempt froze (amount, currency, status, team, subscription version, current period): the scheduled reduction, the next period (`periodAfter`: starts on the old end, ends on the anchor day of the next month, clamped), the ledger rows (`period_start` with the entitlements and the amount it was paid at, and the `charge`), the subscription (`paid_basis` = the amount, `version + 1`), the renewal `paid`, and the **next** renewal and its work row. A mismatch records the payment, applies nothing and sets the renewal to `needs_review`. A second payment for a paid renewal is recorded for review. **A late payment keeps the original boundary** (Dave): a team that pays on day 5 of its grace period gets the next period starting on the old end date, not a shorter one.

**Failure** (`past_due`): the **first** failure fixes `failed_at` and `grace_ends_at = failed_at + RENEWAL_GRACE_DAYS` (default **7**, Dave's number; a retry that fails again keeps both, so retrying cannot extend the grace). Only a failure of the attempt that is charging counts; a late event for an earlier attempt is ignored. In the same transaction the Owner's two emails are written as frozen work rows.

**Retry** (`POST /teams/:teamId/billing/renewal/retry`, Owner only, no body). Allowed only while `past_due`; a second tap is 409. It sets `retry_requested`, writes a work row and returns 202 "confirming"; the worker charges with **attempt + 1**, a new key, and the team's **current** card. There are no automatic retries.

**Read-only** (new, as Dave widened it). One guard, `requireWritable` (`teams/writeGuard.ts`), refuses with **403 `team_read_only`** every team route that writes and is not billing: shifts (create, update, delete), swaps (request, cancel, approve, reject) and invitations (invite, link, resend, revoke). "Read-only" is: the current period's renewal has failed, `grace_ends_at` has passed, and it has not been paid. The guard queries the primary every time (never cached), so a confirmed payment lifts it on the next request. It sits **after** authentication and the membership check, so a stranger gets the same 404 as for a team that does not exist and learns nothing. Reads, sign-in, account recovery and the Owner's billing routes do not use it. A unit test walks the real routers and fails if any write route lacks a step named `requireWritable`. `GET /teams/:id` returns `canEditShifts: false` and the notice, so the app follows the server.

**Notifications** (new). The Owner alone is emailed, through the existing `email` job: one email at the first failure ("we could not collect your renewal", with the last day of full access) and one at the **end of the grace period** ("now read-only"), which the email job **skips** if the renewal was paid by then. Both are frozen when the failure is recorded. The in-app banner is derived from the renewal (the Owner sees the full words; everyone else sees only "this team is read-only" once it is). **Push hook:** `queueOwnerNotices` in `billing/renewalNotice.ts` is the one place that decides these two moments; the push slice adds its rows there, Owner only (issue #53). **The failed-renewal email and the read-only email are always sent, whatever the Owner's `notifyBilling` setting** (decided by Dave, PR #61, 2026-11-03). They warn the Owner that the team is about to lose, or has lost, the ability to make changes, so they are essential service messages, not optional ones. `notifyBilling` governs optional billing notices only. The push slice (issue #53) must treat these two moments the same way: Owner only, and not switched off by `notifyBilling`.

**A blocked reduction needs an exit** (new, and a change to ADR 0029). ADR 0029 said the Owner cannot cancel a reduction after the boundary check. A `blocked` reduction pauses collection, and the Owner has no tool to remove members, so without an exit the team would end up read-only for good. The Owner may now cancel a reduction that is `scheduled` **or** `blocked` (approved by Dave on PR #61, 2026-11-03). Cancelling is the Owner's explicit choice to keep the current plan at its current price; a `ready` or `continuing` reduction still cannot be cancelled.

## Sandbox results (test shards, Stripe sandbox, `stripe listen`; evidence in `Rota-evidence/p6b/`)

| Card | How it was saved | What the renewal did |
|---|---|---|
| 4242 4242 4242 4242 | attached | charged $50.00, `payment_intent.succeeded` arrived, applied once: next period, ledger `period_start` + `charge`, next renewal scheduled. The same event delivered three more times was acknowledged and changed nothing |
| 4000 0000 0000 0341 | attached (this card attaches, then declines) | `payment_intent.payment_failed` (`card_declined`) arrived as a **webhook**, the renewal went past due, 7 days of grace, one email sent to the Owner, the second queued for the end of the grace period. A retry with a replaced 4242 card (attempt 2, new key) succeeded and lifted read-only |
| 4000 0025 0000 3155 | **set up properly**: a SetupIntent with `usage: off_session` and the 3-D Secure test page completed by a person (in the emulator) | the off-session renewal **succeeded with no customer action**. This is how Rota saves a card (Checkout with `setup_future_usage: off_session`), so a 3155 card behaves like any other saved card |
| 4000 0025 0000 3155 | attached with no set-up (not how Rota saves cards) | `authentication_required`: the renewal went past due |
| 4000 0027 6000 3184 (the token `pm_card_authenticationRequired`, which I first took for 3155) | attached | `authentication_required` on every charge: past due. This is the case where the customer really must act (replace the card or ask the bank) |

Also checked: the API refuses `payment_method_types` on a PaymentIntent in this API version (Stripe now manages payment methods from the Dashboard), so the charge sends none; the saved PaymentMethod is a card and that is all it can be. A declined off-session charge does send `payment_intent.payment_failed`, so the failure is recorded by the verified webhook, as designed.

## Schema

One additive migration, `20261101200000_add_renewals` (both shards): the `renewal_status` enum and the `renewals` table (unique per team and period; unique PaymentIntent id; CHECKs that a `charging` renewal is frozen, a `past_due` one has its cause and grace end, a `paid` one is complete, a `needs_review` one has a reason). No foreign key to `teams`. Nothing else changes.

## Consequences and limits

- **A webhook that never arrives leaves a renewal `charging`** ("Confirming your payment" in the app). This is the same limit as an activation payment (ADR 0027); Stripe retries webhook delivery, and the local `stripe listen` must forward the two new events.
- **The Stripe page still offers non-card methods for Checkout** (ADR 0030, choice 9); the renewal charges only a saved `card`, and a team with none follows the failed-renewal path.
- **Keys are per attempt.** A paused or refused attempt (no card, blocked reduction) never reached Stripe and does not use a number.
- The renewal slice **applies** reductions; ADR 0029's "P6 applies it" is done here.
- This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

## Tests

`renewal.unit.test.ts` (periods, grace, wording, emails, the Stripe request, the events, the ledger rebuild), `teams/writeGuard.unit.test.ts` (every write route has the guard), `renewal.integration.test.ts` (test shards): charge once and webhook applies on shard A and B, replay, uncertain-then-resume with one PaymentIntent, attempt budget, 23-hour rule, decline, authentication required, no card, refused request, read-only on every write route with reads and billing still working, a stranger's 404, retry and double tap, a failed retry keeping the grace, reductions applied, blocked and continuing, mismatches to review, a second payment, the webhook's filtering, `ensureRenewals`, activation scheduling, no early run, and the skipped second email.
