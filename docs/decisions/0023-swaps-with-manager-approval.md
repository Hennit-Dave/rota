# 0023: Shift swaps with manager approval

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-28
- **Decided by:** Dave (all five points approved 2026-10-27: two PRs, the manager is the only gate, a party cannot decide their own swap, the enum migration as its own migration, 10 requests per user per hour and at most 3 waiting, both "chosen, not measured")
- **Related:** slice S1, `.agents/rules/app-state.md` (optimistic updates, tests 1, 2, 12, 14), `security.md`, `data.md`, ADR 0021 (shifts), ADR 0022 (the feed), Figma 06 Swaps

## Problem

A staff member wants to trade a shift with a teammate, and a manager must agree. When someone taps "Request swap" and the answer is slow, they tap again; a retry after a timeout must not create a second request. Approving changes who works two shifts at once, so it must be all-or-nothing and safe against the schedule changing in the meantime.

## Options considered

1. **The teammate must accept first.** Fairer to the teammate, but Figma has no such step ("Your manager will review the request") and it doubles the screens and the states. Not chosen: the manager is the only gate (Dave).
2. **A swap by handing a shift to someone** (no exchange). Simpler, but it is not what Figma draws (You give / You receive, two shifts).
3. **Exchange two shifts, one request, one manager decision.** Chosen.
4. **Idempotency by the disabled button only.** A button cannot stop a network retry. Rejected (`app-state.md`).
5. **Idempotency by the client's key, stored with the request and enforced by a unique index.** Chosen.

## Decision

**What a request is.** The requester's own upcoming shift (`offered`) for a teammate's assigned upcoming shift (`requested`). The caller, and who the other person is, are never sent: the server takes the caller from the token and the counterparty from the requested shift's assignee. Open shifts, one's own shifts, shifts that have started, a shift of another team, and a shift already in a waiting swap are refused (`400` with a per-field code, or `409`).

**Idempotency (the self-study topic).** The app makes one `Idempotency-Key` (a UUID) per request, when the confirm screen opens, and sends it in a header. The key is stored with the request; `UNIQUE (team_id, requester_user_id, idempotency_key)` makes the database refuse a second insert. A repeat returns the stored request (`200`, not `201`). Two simultaneous repeats: one inserts and the others get it back (they queue on the requester's membership row, then look the key up again inside the transaction). The same key with a different pair of shifts is `400 key_reused`, not an unrelated swap. The key is sent again unchanged if the request is replayed after a token refresh.

**Limits (approved, chosen, not measured).** 10 requests per user per hour (`swap_request_user`, fails closed when Valkey is down) and at most 3 waiting per person (`SWAPS_MAX_PENDING`, exact under concurrency because requests from one person queue on their membership row). A retry of an existing request is still answered when the person is at the limit.

**Who decides.** `swaps.approve` (Owner, Manager). A person who is **part of** the swap may not decide it: a Manager never; an Owner only when there is no other Owner or Manager on the team (otherwise it could never be decided). The server returns `canDecide` and `canCancel` per request so the app shows the right buttons, and checks again on every action. Staff who call approve or reject directly get `403` and nothing changes.

**Approval.** One transaction: lock the request, check who may decide, lock both people's membership rows (in a fixed order) and both shifts, and check against the live rows that both shifts still belong to who they did, have the same times, are still in the future, and that neither person ends up double-booked (the C1 overlap rule). Only then do the two shifts change hands, the request become `approved`, and one feed row (`swap_approved`) is written. If any check fails the answer is `409 swap_not_possible`, nothing moves, and the request stays pending so a manager can reject it. Requests also take a snapshot of both shifts, so they still read correctly after the shifts have changed hands.

**Cancel and reject.** The requester may cancel while it waits (no feed row). A manager rejects (`swap_rejected` feed row). Every decision is conditional on the status being `pending`, so two decisions at once give one winner (`409 swap_not_pending`).

**The app (optimistic update with rollback).** "Send swap request" shows "Request sent" at once with the control off (a guess built from the two shifts on screen, granting no action); the server's answer replaces the guess; on any failure the list goes back exactly as it was and the screen says why. Connectivity is checked before sending: offline, nothing is sent, nothing is queued, nothing is resumed later (`networkMode: 'always'`, `retry: 0`, no mutation scope, `onlineManager` fed by NetInfo).

**Migrations (two, as approved).** `20261028100000_add_swap_activity_kinds` adds three values to `activity_kind` (`swap_requested`, `swap_approved`, `swap_rejected`); `20261028110000_add_swap_requests` creates `swap_status` and `swap_requests`. No existing row is touched.

## Why

- The unique index is the only thing that holds when two retries race; the application check is a courtesy.
- Re-checking the live rows at approval makes "the schedule changed while it waited" an explicit, visible refusal instead of a silent wrong swap.
- Letting the server say who may decide keeps the app free of permission rules.

## Consequences

- A teammate can be swapped without agreeing first; the manager is the only protection. A teammate-accepts step can be added later without changing the table's meaning.
- No notification is sent when a request is made or decided (push is a later slice), so the screens say what is true: the person sees the result when they open the app.
- A request whose shifts are edited stays pending (and approval will refuse it) until a manager rejects it or the requester cancels; it is not cancelled automatically.
- The pickers offer shifts from the next 41 days (the server's range cap is 42); a swap further out needs the schedule to be browsed first. Revisit with the offline slice.
- The approval's second layer of role checking (the service refuses a non-approver as well as the route's permission) means removing the route's permission alone would not open it: two independent layers, so the mutation that removes only the route check is not caught by a test. The service layer is covered by the rules unit test and the end-to-end 403 test.
- A dropped or unreachable database connection (`EADDRNOTAVAIL`, `ECONNRESET`, `ETIMEDOUT`, Prisma `P1001`/`P1002`/`P1017`) is answered `503 service_unavailable`, not `500`, for every route (`server/src/http/errors.ts`, `http.unit.test.ts`). Found when a flapping network failed the idempotency integration test with `read EADDRNOTAVAIL`. For a swap request a 503 is safe to retry with the same key.
- Revisit when: push exists (notify both people and the managers), the load test or real use shows 10 an hour and 3 waiting are wrong, or swaps with an open shift are wanted.

## Evidence

- `server/src/swaps/swaps.integration.test.ts` (19 tests, test shards, real Valkey): request and approve end to end, the two shifts change hands and the feed says so; **idempotency** (a retry returns the stored swap, five simultaneous retries create exactly one request and one feed row, the same key for a different pair is refused); eligibility per field; double-booking refused at the request and again at approval; stale requests (reassigned, rescheduled, deleted, someone left) fail at approval and stay pending; a shift that has started; **Staff cannot approve or reject** (403, nothing changes, nothing recorded); a party cannot decide their own swap (Manager never, Owner only as sole approver); reject, double decision, two simultaneous approvals give one winner; cancel rules; the limit of 3 (also under five simultaneous requests); 429 at the rate limit; 503 with Valkey down; team isolation across both shards (identical 404 on every route); who sees what; a removed member loses access at once. Mutation-checked: the party rule and the in-transaction idempotency re-check each fail the right tests.
- `server/src/swaps/rules.unit.test.ts` (5).
- App: 296 tests, including the optimistic lifecycle with the real TanStack core (the guess shows before the answer, is replaced by it, is rolled back on error, is removed when there was no list; offline it fails at once without pausing and nothing is sent after reconnecting) and the idempotency header (sent, kept on a refresh replay, never able to replace the token).
- Emulator, local API, test shards: request, a failure with the API stopped then Try again (one swap in the database), offline in airplane mode (no request reached the API, then or after reconnecting), the server's refusal shown, the Owner's review and approval, and the feed with the swap rows. Screenshots and the replay log are kept outside the repo and linked in the pull request.
