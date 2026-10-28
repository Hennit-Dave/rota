# 0026: Billing engine and schema: pure proration, an append-only ledger, no Stripe yet

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-28
- **Decided by:** Dave (payments plan approved 2026-10-28: slices P1 + P2 as one PR, test shards only; an unactivated team works within Starter's limits, no read-only state before activation; the 30-minute operation expiry and 10-second Stripe timeout are labelled chosen, not measured)
- **Related:** `.agents/rules/money.md`, `AGENTS.md` rules 1, 2, 6, 8, `.agents/rules/data.md`, ADR 0002 (work rows), the brief (Requirement 6, billing)

## Problem

Billing is the part of Rota where a wrong number costs a customer money. Before any payment code exists, the calculation, the periods and the tables that hold the money record need to exist and be proven on their own, so the Stripe slices that follow only have to move an amount we already calculated.

## Options considered

1. **Build the schema and Stripe together, calculate inside the handlers.** Faster to a demo, but the formula would be tested only through HTTP and Stripe, and a rounding or period bug would surface as a wrong charge. Rejected.
2. **A pure engine first (no database, no Stripe), then the schema, then Stripe.** The 13 acceptance cases run in milliseconds with no network; the schema is proven by its own constraints. **Chosen.**
3. **Use Stripe's own proration or Subscriptions.** Forbidden by `AGENTS.md` (rule 6). Not an option.

## Decision

**Engine (`server/src/billing/`).** Pure functions over integers: `plans.ts` (the only place a price lives), `periods.ts` (calendar-month anniversaries from the activation day, clamped to the month's last day, computed from the first month so a short February cannot drag March back), `proration.ts` (the formula), `ledger.ts` (the rows a change writes and the fold that rebuilds state from them).

- **The formula is `money.md`'s, unchanged:** `floor(new_monthly × remaining ÷ period_days) − floor(paid_basis × remaining ÷ period_days)`, with each term rounded down separately, multiply before divide. It uses `BigInt`, whose division truncates (floor for non-negative values) and cannot lose precision above 2^53. `period_days` is 28 to 31 and always comes from the period row; the engine refuses any other length.
- **A change is split per dimension.** Plan and seats are separate: a higher tier applies now, a lower tier waits for the period end; more seats apply now, fewer wait. The part that applies now is priced against `paid_basis` (never against the old plan's price): above it, it is paid; at or below it, it is free and immediate with `paid_basis` unchanged; nothing applying now means `scheduled_only`. This is `money.md`'s change-type table written as code, and it covers the mixed case.
- **A paid change keeps its calculation** (`gross`, `credit`, `remaining`, `period_days`, `paid_basis`), because the ledger writes a credit row and a charge row whose sum is the payment, not one net row.

**Schema (migration `20261028190000_add_billing`, both shards, test shards first).**

- `billing_periods`, `subscriptions` (a projection, no row until the team activates), `payment_operations` (frozen quotes; a partial unique index allows one open operation per team; the payment ID and Checkout session ID are unique across operations), `payment_requests` (idempotency key, fingerprint, stored answer), `ledger_entries`, and `stripe_events` (the webhook inbox, used on shard A).
- **The ledger is append-only in the database:** a row trigger rejects `UPDATE` and `DELETE`, and a statement trigger rejects `TRUNCATE`. Its types are `period_start`, `entitlement_change`, `charge`, `credit`, `refund`, `correction`; state rows carry the plan, seats and paid basis after the entry, money rows carry none, and CHECKs enforce both shapes and the signs (a charge is positive, a credit or refund negative). `(operation_id, entry_type, sequence)` is unique, so replaying an operation writes nothing. `operation_id` names the business operation: a payment operation's ID for a paid change, a fresh ID for a free one. Order is a database-generated `position`.
- **No foreign key from a billing table to `teams`.** Money history must outlive the team row and the ledger can never be deleted; billing tables reference each other only where a row means nothing without the other (a period). Team isolation is by `team_id` in every query, as for every team-owned table.
- **No `state` column yet** (grace, read-only, paused): it could not be rebuilt from the ledger today, so it arrives with the renewal slice together with the ledger type that records it.
- Every money column is `INTEGER` cents (a test lists them and fails on any float or decimal column). Currency is `usd`, checked.

**An unactivated team** has no subscription row and works normally within Starter's limits (5 seats, no extra seats), with an "Activate subscription" banner for the Owner (Dave, 2026-10-28). Restricted access follows only a failed renewal, after the grace period. There is no read-only state before activation.

## Why

- A pure engine makes the highest-risk code the cheapest to test, and the rules file's acceptance cases become the engine's tests literally.
- Rebuildability is proved by property, not by hope: the tests apply sequences of changes to a stored state and, separately, write their ledger rows and fold them back, and both must agree, in memory and in the database on both shards.
- Triggers hold through the pooler (they run in the database); the limit is that a database owner can drop the trigger or the table, which stops the application, a stray query and a test, not an administrator.

## Consequences

- **Test data stays.** Ledger rows and the periods they reference can never be deleted, so integration tests use fresh random team IDs and leave their rows on the TEST shards. Nothing depends on a clean database.
- **Open question for P4 (found while checking Stripe's docs):** Stripe's minimum USD charge is **$0.50** ([Stripe, currencies](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts)). The formula can produce a smaller net amount for a small mid-period increase (Team 15 to 16 seats with 1 day left is 10 cents). The engine returns the formula's number unchanged; what the product does below the minimum is Dave's decision before the change flow is built.
- **Scheduled changes** (decreases, mixed changes) write nothing to the ledger yet. Their own ledger type arrives with the slice that schedules and applies them, as an additive enum value.
- **Revisit** if a ledger row ever needs a field the CHECKs forbid, or if the position order stops matching the order of a team's changes (it relies on the subscription row lock serialising a team's operations).

## Evidence

See the PR description: the 35 unit cases, the 26 schema tests on both test shards, the migration status on both test shards, and the SQL showing the trigger refusing `UPDATE`, `DELETE` and `TRUNCATE`.
