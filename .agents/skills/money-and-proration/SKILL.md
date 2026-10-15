---
name: money-and-proration
description: Procedure for any Rota change that calculates, quotes, charges or records money - plan and seat changes, proration, payment operations, Stripe charges, ledger entries and renewals. Use before writing or changing any billing code or billing test.
---

# Money and proration

All prices, formulas, periods, change types and test cases live in `.agents/rules/money.md` (path from
the repo root). **Read it in full before starting; never copy its numbers into code comments, other docs
or this skill.** Anything in the payment or ledger path needs Dave's "go" first (`AGENTS.md`).

## Steps

1. **Confirm the change belongs on the server.** If any part of it would calculate, compare or decide money
   in `app/`, redesign it as a server endpoint that returns finished figures (`money.md`, first section).
2. **Classify the change** with the change-types table in `money.md`: increase that raises the amount above
   `paid_basis`, increase that doesn't, decrease, or mixed (split).
3. **Load the inputs from the database, never from the client:** current entitlements, `paid_basis`, the
   current period row (`period_days`, start, end), and the subscription `version`.
4. **Calculate** with the formula and rounding rule in `money.md`: integers only, multiply before dividing,
   `period_days` from the period row, never a literal number of days.
5. **If payment is needed, create a payment operation** that freezes the quote, base version, target state
   and currency (`money.md`). Respect "one open paid operation per team".
6. **Create the payment session** as the one bounded synchronous Stripe call, with the operation's stable
   idempotency key; the app's `Idempotency-Key` header is handled as `money.md` describes.
7. **Apply nothing until the webhook path confirms payment** (`webhook-handler` skill). Changes that need no
   payment apply immediately or at period end, as the table says.
8. **Ledger:** every applied change writes its rows in the same team-shard transaction that updates the
   subscription, deduplicated by `(operation_id, entry_type, sequence)` (`money.md`).
9. **Tests:** every case in `money.md`'s unit-test table and its "also required" list that this change
   touches. Use those cases as fixtures by reference; if a value seems wrong, raise it with Dave rather than
   editing the expected result.
10. **Renewals:** stop. `money.md` requires explaining the test-mode collection flow to Dave first.

## Worked example: upgrade mid-period

A Starter team upgrades to Team mid-period (unit test 1 in `money.md`, the brief's own example):
- Classified as an increase that raises the amount → needs payment.
- Inputs loaded from the database; charge calculated with the formula and that period's `period_days`.
- A payment operation freezes the quote and base version; Checkout is created with the operation's key.
- Only after the confirmed webhook does one transaction write the ledger rows, raise `paid_basis`, update
  entitlements and complete the operation.
- The unit test asserts the result named in `money.md`; the integration test asserts the ledger rows and
  that a replayed webhook writes nothing new.

## Common mistakes

- Using the entitled monthly amount instead of `paid_basis` as the "old" side.
- Hard-coding 30 days.
- Floating-point arithmetic, or rounding the difference instead of each term.
- Treating "higher tier" as "costs more".
- Applying a change when Checkout reports `complete` but not `paid`.
- Charging again for a period already paid at a higher basis.
- Following a Stripe Subscriptions tutorial.
- Showing a client-side estimate "just for display".
