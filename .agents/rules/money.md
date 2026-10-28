---
trigger: model_decision
description: "Read before touching prices, plans, seats, proration, charges, Stripe Checkout or PaymentIntents, idempotency keys, Stripe webhooks, the ledger, subscription state, renewals, failed payments, or any number the app shows about money."
---

# Money, proration and payments

If a rule here conflicts with `AGENTS.md`, stop and ask. Anything in the payment or ledger path needs
Dave's go-ahead first (`AGENTS.md`). The tests at the end are the acceptance criteria.

## No money logic in the app

- The server alone calculates and decides money; prices live only in server code. The app never does
  arithmetic on amounts, holds prices, computes a preview, subtotal, total, credit or tax, or decides that a
  payment succeeded. "You'll be charged X today" comes from a server endpoint; the app only formats it.
- *Why: two implementations of one formula eventually disagree, and the worst version is the customer
  seeing one number and being charged another.*
- **Review aids, not proof** (run before every billing PR, then read the diff): `rg -n "\b(2000|5000|12000)\b" app/`
  and `rg -n "(amount|price|total|cents)\w*\s*[-+*/%]" app/`. Harmless UI values can match, and money
  logic can evade both patterns.

## Units and plans

- Integer US cents everywhere, never floating point; Stripe receives the same integers, currency `usd`.

| Plan (tier order) | Price | Seats included | Extra seat |
|---|---|---|---|
| 1 Starter | 2000 cents/month | Up to 5 | Not available |
| 2 Team | 5000 cents/month | Up to 15 | 300 cents/month |
| 3 Business | 12000 cents/month | Up to 40 | 200 cents/month |

- **Monthly amount** = plan price + max(0, seats − included) × extra-seat price. Starter never exceeds 5.

## Billing periods (decided: calendar-month anniversaries)

- **Each team's subscription has its own activation date and anchor**, set when that subscription
  activates, not when the account signed up. One user may own several teams, each billed separately.
- The subscription stores a **billing anchor day** (1–31): the UTC calendar day of activation.
- Each period runs from its start to the anchor day of the next month, **clamped to that month's last
  day**. The anchor itself is never changed by clamping: anchor 31 gives Jan 31 → Feb 28 (29 in a leap
  year) → Mar 31 → Apr 30 → May 31.
- So `period_days` is 28–31 and is read from the period row. **Never a literal `30` in code.** The brief's
  example still gives 2000 in any 30-day period.
- Boundaries are 00:00 UTC; a period is `[start, end)`.
- **First period:** starts at 00:00 UTC on the activation date, even if activation happens later that
  day, and is charged in full. **The checkout summary says so**, using server-provided wording.
- A change on day `d` (day 1 = first day) leaves `remaining = period_days − d + 1`. A change at or after
  `end` belongs to the next period.
- **At `end`:** scheduled changes apply first, then the renewal charges the resulting monthly amount.

## Three separate values per period

| Value | Meaning |
|---|---|
| Entitlements | The plan and seats the team can use right now |
| `paid_basis` | The monthly amount this period has been paid at. Set by the renewal; raised only by a paid change |
| Next renewal amount | The monthly amount of the entitlements after scheduled changes |

*Why: after a cheaper upgrade, the team holds the new plan while the period stays paid at the old amount.
Mixing these up either charges twice for time already covered or silently switches calculation bases.*

## Proration formula and rounding rule

```
charge_today = floor(new_monthly × remaining ÷ period_days) − floor(paid_basis × remaining ÷ period_days)
```

`new_monthly` is the monthly amount of the target entitlements. **A change is paid only if
`new_monthly > paid_basis`**; on payment, `paid_basis` becomes `new_monthly`.

Multiply before dividing, in integers. Each term rounds down separately, as the brief's example does.
**Worked example (brief, must equal 2000):** Starter, 5 staff, 30-day period from the 1st; on the 11th
upgrade to Team with 9 staff. remaining = 20; floor(2000×20÷30) = 1333; floor(5000×20÷30) = 3333;
**charge 2000**. Next period: 5000.

## Change types

| Change | When it takes effect | Charge |
|---|---|---|
| Increase (higher tier or more seats) with `new_monthly > paid_basis` | **After verified payment** | The formula |
| Increase with `new_monthly ≤ paid_basis` (seats inside the allowance; a higher tier that costs the same or less) | **Immediately** | 0, no mid-period refund; `paid_basis` unchanged; the new amount applies from renewal |
| Increase with `new_monthly > paid_basis` but a formula charge **under 50 cents** (Stripe's USD minimum) | **Immediately** | 0; `paid_basis` unchanged; never rounded up to the minimum. Exactly 50 cents is paid (Dave, 2026-10-28; ADR 0026) |
| Decrease (lower tier or fewer seats) | **End of period**, even if it costs more | 0 now; no refund (brief) |
| Mixed (e.g. higher tier with fewer seats) | **Split:** increases now under the rows above, decreases at period end | Formula on the increase only, if it raises the amount |

*Why for the 50-cent row: Stripe cannot collect less than $0.50, so a smaller charge is applied free. A later paid change is priced as if it had not happened, so nothing is charged twice.*

*Why: tier and price don't move together. Team with 50 seats costs 15500; Business with 50 costs 14000.
The cheaper upgrade is our chosen policy: apply now, no refund, lower amount from renewal.*

## Payment operations (frozen quotes)

- A paid change creates a **payment operation** row on the team's shard first, freezing: the base
  subscription `version`, the current and target plan and seats, the period, the quoted amount, and
  currency. Stripe metadata carries `team_id` and the operation ID.
- **One open paid operation per team** (partial unique index). While it is open, every other subscription
  change returns 409. It expires after a set time (config) if unpaid.
- Applying it requires `subscription.version = operation.base_version` and bumps the version. A mismatch
  never applies: the payment is recorded and the operation goes to human review.
- Payment-session creation is the one synchronous provider call (`AGENTS.md` rule 10). The app sends an
  `Idempotency-Key` per attempt; the server stores key, request fingerprint and result in Postgres. Same
  key → stored result; same key, different request → 422. Stripe charge calls use a stable key per
  operation, never per job generation or attempt; after an uncertain result, look up the existing payment
  first (`jobs.md`).
- **No Stripe Subscriptions, no quantity changes.** Wording: "This integration uses Stripe test mode only.
  Live-payment eligibility has not been verified."

## Webhooks and confirming a payment

- `express.raw({ type: 'application/json' })` on the webhook route only, before any global `express.json()`.
  Verify the signature against the raw body before parsing. Then Zod, then record in the **shard A inbox**
  keyed by Stripe's event ID (unique), then acknowledge. Processing is a job (`jobs.md`).
- **First, recognise a payment already applied:** if an operation already records this provider payment
  ID (PaymentIntent ID, unique across operations), do nothing. If the operation is complete but under a
  **different** payment ID, record it and send it to human review.
- **A valid signature proves Stripe sent the event, not that this change was paid for.** Otherwise apply
  only when all match: the operation from metadata exists and is open; same team; amount equals the frozen quote;
  currency `usd`; payment status is successful (for Checkout, `payment_status` is `paid` — a `complete`
  session can still be unpaid; handle the async success event too). Any mismatch → record, don't apply,
  human review.
- **One transaction on the team's shard:** if the operation is already complete, do nothing; otherwise
  insert its ledger entries, update the subscription, store the provider payment ID, and mark the
  operation complete. **Afterwards** mark
  the shard A inbox row processed. A crash between the two is safe: the replay finds the operation complete.
- Two Stripe events for one payment resolve to the same operation, so the second is a no-op.

## Ledger (brief)

- Append-only, enforced in the database (a trigger rejects `UPDATE` and `DELETE`). Corrections are new rows.
- Records charges, credits, refunds, corrections, **and every plan or seat change and period start**, so
  subscription state can be rebuilt from the ledger alone. Integer cents; `team_id`, type, operation ID,
  Stripe IDs where they exist.
- **Deduplication by business effect:** unique `(operation_id, entry_type, sequence)`, so one payment may
  write several legitimate rows (credit, charge, state change) and replays write none. Webhook receipt is
  deduplicated separately, by event ID, in the inbox.
- A pure function rebuilds subscription state from the ledger; tests compare it with the stored state.

## Reductions that leave too many members

- Scheduling a reduction below the current active member count requires the Owner to **select which
  members** become inactive at period end (never the Owner). Without a valid selection, the request is
  rejected (422).
- Once scheduled, invites that would exceed the future limit are refused.
- The Owner is notified before the boundary (job). At the boundary the selection is re-checked.
- **If active members would still exceed the limit,** the reduction does not apply and the old, higher
  price is **never charged silently**. Default: **collection pauses**, the Owner is notified, and the team
  follows the failed-renewal path (grace, then read-only) until it's resolved. Continuing at the old price
  happens only if the Owner explicitly accepted that fallback when scheduling, with the accepted wording
  and time stored.
- Members are deactivated, never deleted.

## Renewals and failed renewals

- **Stop and ask before implementing renewals.** First explain the test-mode collection flow: saving a
  payment method, consent to charge it later, and any customer action. One-time Checkout doesn't set up
  future charges.
- Renewals are work rows with `run_at` = period end (`jobs.md`), one per team per period, with a charge key
  per period.
- **Failed renewal (brief):** a grace period of a set number of days (config), Owner notifications (jobs),
  then **read-only access**: nobody creates or edits shifts. Authentication, account recovery and the
  Owner's billing access always keep working.

## Never cache

Active subscriptions, payment status, credit balances, webhook idempotency records (brief). Primary only.

## Unit tests (brief: at least 8; 30-day period fixtures)

| # | Case | Inputs | Result |
|---|---|---|---|
| 1 | Upgrade (brief) | Starter 5 → Team 9, remaining 20 | **2000**, applies after payment |
| 2 | Downgrade | Team → Starter | **0** now; Starter from next period |
| 3 | Seats inside the allowance | Team 12 → 15, remaining 12 | **0**, applies **immediately** |
| 4 | Remove seats | Team 18 → 15 | **0** now; 15 from next period |
| 5 | First day | Starter 5 → Team 9, remaining 30 | **3000** |
| 6 | Last day | Starter 5 → Team 9, remaining 1 | **100** |
| 7 | Two changes, one period | day 11 Starter 5 → Team 9; after it applies, day 21 Team 9 → Business 9 | **2000**, then **2334** |
| 8 | Seats beyond the allowance (our choice) | Team 15 → 18, remaining 12 | **360** |
| 9 | Under Stripe's minimum | Team 15 → 16, remaining 1 (formula 10); remaining 4 (40) | **0**, immediate, `paid_basis` stays 5000; remaining 5 (50) is **50**, paid |

Also required: Team 50 → Business 50 applies immediately with charge 0 and 14000 from renewal; then, same
30-day period with 10 days left: Business 50 → 55 (15000 ≤ `paid_basis` 15500) → immediate, **0**, and
Business 55 → 60 (16000) → **167** = floor(16000×10÷30) − floor(15500×10÷30); `paid_basis` then 16000; anchor 31
gives Feb 28 (29 in a leap year) then Mar 31; a mixed change splits correctly; a 31-day-period fixture uses 31, not 30; the sixth
Starter invite fails; same `Idempotency-Key` → one operation, different body → 422; a second paid change
while one is open → 409; version mismatch → no apply; wrong amount, currency, team or an unpaid `complete`
session → no apply; a second event for an already-applied payment is a no-op, a different payment for a completed operation
goes to review; two events for one payment → one set of ledger rows; an unresolved over-limit reduction
pauses collection unless the stored fallback acceptance exists; crash after the shard
transaction → replay completes the inbox only; ledger `UPDATE`/`DELETE` fails; ledger rebuild matches;
over-limit reduction without a selection → 422.
