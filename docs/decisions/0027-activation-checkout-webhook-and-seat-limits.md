# 0027: Activation: Stripe Checkout, the verified webhook, the processing job and seat limits

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-29
- **Decided by:** Dave (payments plan approved 2026-10-28, section 5 and the answers to section 7; P3 started 2026-10-29 in "lean mode"). Choices 1 to 5 below were proposed by me and **approved by Dave on 2026-10-29**.
- **Related:** `.agents/rules/money.md`, `.agents/rules/jobs.md`, `AGENTS.md` rules 1, 2, 3, 6, 7, 9, 10, 13, ADR 0026 (engine and schema), ADR 0016 (jobs run through work rows), the `webhook-handler` skill

## Problem

A team has to be able to pay for the plan it chose, and the app has to learn that it did, without the app, the Checkout page or a forged request ever being the thing that decides it. The seat limit ("an owner on Starter cannot invite a sixth person") has to hold on the server. All of it must use Stripe test mode only: **This integration uses Stripe test mode only. Live-payment eligibility has not been verified.**

## Options considered

1. **Trust the browser return.** Treat the return from Checkout as "paid". A user can open that link without paying. Rejected (rule 7).
2. **Process the webhook inside the request.** Simplest, but a slow database or a crash after Stripe is told "ok" loses the payment. Rejected (rules 7 and 10).
3. **Verify, record, acknowledge; decide in a job.** The request verifies the signature on the raw body, records the event once on shard A, enqueues, and answers. A job matches the payment against the operation we froze and applies it in one team-shard transaction. **Chosen** (the plan, section 5).

## Decision

**Creating the payment (the one synchronous Stripe call, rule 10).** `POST /teams/:teamId/billing/activation` (Owner only, `Idempotency-Key` header, body `{ plan, seats }` and nothing else; unknown fields are 400). In one transaction under the team row lock it freezes a `payment_operations` row (our engine's amount; the first period is charged in full, so `remaining = period_days` and nothing is credited) and the `payment_requests` row for the key, **before** Stripe is called. The Stripe call is bounded (10 s, no SDK retries) and uses the stable key `op-<operationId>`. Its result is stored on the operation and in the key's stored answer. Nothing about the payment's outcome is recorded here.

- **Same key, same request:** the stored answer (200, no second Stripe call). **Same key, different request:** 422. **A second attempt with a new key while one is open:** 409.
- **An uncertain result** (timeout, connection, 5xx, rate limit) leaves the operation open and answers 503. Retrying with the same key resumes it: Stripe returns the session it already made. **A definite refusal** closes the operation as `failed` so the team is not blocked.
- **Seats** are the integer the Owner typed; the monthly amount comes from `plans.ts`. The Zod bound of 10 000 seats per request is a request-size guard, not a product limit.
- **Returned to the app:** only finished strings (`"$50.00"`), the Checkout URL, and a status the server decides: `awaiting_payment`, `confirming` (a verified event is recorded but not yet processed), `paid`, `failed`, `expired`, `under_review`. The app never divides cents.

**The webhook (`POST /webhooks/stripe`).** `express.raw` on this route only, registered before every router (the app has no global `express.json()`). In order: signature header present and body raw, `stripe.webhooks.constructEvent` on the raw bytes (before anything is parsed or logged), Zod on the envelope, **live-mode events refused** (400, logged loudly, never recorded), event types we do not act on acknowledged and not recorded, Checkout Session events with our `team_id` and `operation_id` metadata recorded on shard A (the work row and the `stripe_events` row in one transaction, `ON CONFLICT DO NOTHING` on the event ID), then enqueued, then 200. A repeated event ID that is processed is acknowledged; one that is recorded but unprocessed is enqueued again (jobs.md, "Stripe redelivery"). Subscribed events: `checkout.session.completed`, `.async_payment_succeeded`, `.async_payment_failed`, `.expired`. **Not** `payment_intent.*`.

**The processing job (`stripe_event` work row).** A valid signature proves Stripe sent the event, not that this change was paid for. The job applies a payment only when all of these hold, and otherwise records why and sends the operation to review (`needs_review` with a reason, or the inbox outcome `review`): the operation exists for this team; `payment_status` is `paid` (a `complete` session can be unpaid: that is `ignored`, and the async success event follows); no operation already records this payment ID (then it is a recorded no-op `duplicate`); the operation is still open; the amount equals the frozen quote; the currency is `usd`; the session is the one we created; and our own engine, re-run, gives the quoted amount. Then, in **one team-shard transaction** (under the team row lock): the first billing period, the ledger rows (`period_start`, `charge`), the subscription at version 1, and the operation completed with its payment ID. **Only after that commits** is the inbox row marked processed, so a crash between the two is safe: the replay finds the operation complete and only finishes the inbox (tested).

**Seat limits.** A seat is an active member, the Owner included. A usable invitation (not accepted, revoked or expired; email or link) holds a seat for its person. The limit is the subscription's seats, or Starter's 5 for a team that has not activated. Enforced twice: when an invitation is made (members plus usable invitations may not exceed the limit: 409 `seat_limit_reached`, rolled back) and, **authoritatively**, when it is accepted (the invitation is consumed and the membership written in one transaction under the team row lock; a full team refuses, consumes nothing, and leaves no directory row). The lock is what makes two simultaneous invitations or accepts unable to take the same last seat. Activation refuses fewer seats than members (422), and the job refuses to activate a team that outgrew its seats while paying (review).

**The app.** Pure JavaScript over `expo-web-browser`, which is already in the build: **no native rebuild**. Screens: activate (plan, seats, the server's price), payment status (waiting, confirming, paid, failed, cancelled, under review), and the Owner's "Activate subscription" banner on the schedule. Stripe sends the buyer back to `https://rota.davebuilds.design/checkout/return?operation=<id>` (or `/cancel`), App Links the app already declares. Opening one consumes nothing: it opens the status screen, which asks the server. The app opens only an https address on `stripe.com`.

**Test mode is enforced in code.** `loadStripeConfig` refuses to start the API with anything but an `sk_test_` key (`sk_live_`, restricted keys and test restricted keys are all refused) and never puts a value in a message. The gateway refuses a Checkout Session that answers with `livemode: true`, and the webhook refuses live events.

## Choices (1 to 5 approved by Dave, 2026-10-29; all **chosen, not measured** unless said)

1. **31-minute lifetime, not 30  (approved).** The plan said 30 minutes, "the Stripe minimum". Stripe's docs give `expires_at` as 30 minutes to 24 hours from creation, and ours is computed a moment before Stripe receives the request, so exactly 30 can arrive as 29 minutes 59 seconds. The operation and the session both last 31 minutes and end together. Change `OPERATION_LIFETIME_MS` if you prefer 30 and accept a possible rejection.
2. **No `payment_operation_id` column on `work_rows`  (approved).** `jobs.md` lists one. Adding it is a schema change on both shards and the worker maps work rows by hand, so P3 instead puts the matching fields in the work row's existing `payload` (team ID, operation ID, session, payment ID, amount, currency, status) and every job log line carries `operation_id`. If you want the column, it is a small additive migration for a later slice.
3. **Cancel ends the operation here, not on Stripe's side  (approved).** Closing the Checkout Session early needs a second synchronous Stripe call (rule 10 allows one) or a new job kind. Instead "start again" marks our operation `expired` so a new attempt can begin, and the old session dies at its own expiry (at most 31 minutes). A payment made on it in that window is recorded and sent to review, not applied. A job that expires the session is the fix if you want it.
4. **Rate limit on billing writes, 10 per user per hour  (approved)**, the swap and invite-link precedent: `RATE_LIMIT_BILLING_USER_MAX` / `_WINDOW_SECONDS`.
5. **The status screen asks the server every 3 seconds (approved)** until it is settled (`OPERATION_POLL_MS`). No Stripe or server push exists for the app yet.
6. **The activation date is the day the operation was created (UTC).** If a payment lands after midnight UTC, the first period still starts on the earlier day (money.md: the first period starts at 00:00 UTC of the activation date).
7. **Lazy expiry.** An open operation past `expires_at` is marked expired when the team next starts a payment (or is reported as expired by the status endpoint); there is no timer. A payment that arrives for an expired operation goes to review.
8. **Existing tests that make more than four invitations on one team** now give the team room with a real activation fixture (`seedActiveSubscription`), because Starter holds five seats. Nothing was relaxed to make them pass.

## Consequences and limits

- **Not built here (later slices):** plan and seat changes (P4), reductions (P5), renewals and failed renewals (P6: `money.md` requires explaining the collection flow first), notification of the Owner (the push slice, issue #53), and the deployed webhook endpoint (waits for the deployment provider; local proof uses `stripe listen`).
- **Money is only ever on shard-local tables of the team plus the inbox on shard A.** A subscription is never cached (rule 11); the status endpoint reads the primary every time.
- **A Valkey failure never blocks recording a payment event:** the event and its work row commit to Postgres first; a failed enqueue leaves the row eligible for the next reconciliation sweep (rule 13, jobs.md).
- **Test data stays** on the TEST shards (ledger rows cannot be deleted, ADR 0026); the harness removes the inbox rows and work rows it made.
- **Revisit** if Stripe's Checkout starts sending an event our four do not cover for a delayed payment method, or if the 31-minute window blocks teams too often.

## Evidence

See the PR description. Tests: 26 activation and 7 seat-limit integration tests on both test shards, 11 new server unit tests, the 54 existing invite tests unchanged, 13 new app tests (one of them the regression test for the status-screen loop below). Real Stripe (sandbox, test mode), 2026-10-29: a successful activation with test card 4242 (the ledger rows by SQL), a declined card (4000 0000 0000 0002) that applies nothing, the same event delivered three times writing no new rows, and the sixth Starter seat refused with 409.

**A bug found on the emulator and fixed in this slice:** the status screen stayed on "Confirming" while the server said `paid`, and the app asked every 0.6 s (2037 requests before it was noticed). `useOperation` invalidated the `['billing', user, team]` prefix from inside its own query function; that prefix includes the query itself, and invalidating a query that is fetching and already holds data cancels that fetch, so the newer answer never landed. The query function is now pure and the refresh of the overview and the team detail is a separate, `exact` invalidation (`operationQuery.ts`). The regression test failed before the fix and passes after.
