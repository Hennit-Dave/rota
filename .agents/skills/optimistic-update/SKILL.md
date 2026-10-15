---
name: optimistic-update
description: Procedure for Rota's optimistic updates with rollback - swap requests and per-field settings changes - covering the TanStack mutation lifecycle, disabled controls, connectivity checks, no offline queuing, the swap idempotency key and the matching server endpoint. Use when building or changing either flow.
---

# Optimistic update with rollback

The brief requires this for **swap requests and settings changes** (Requirement 2). All rules are in
`.agents/rules/app-state.md` ("Optimistic updates with rollback" and "Settings across devices"); the
server side follows `add-api-endpoint`. Paths are from the repo root.

**First touch:** explain in plain words before the term, using the brief's "Request swap" example. The
swap idempotency key is the **idempotency** self-study topic: prompt Dave's `LEARNING-LOG.md` entry
(`self-study-and-log.md`).

## Steps

1. **Plan and wait for "go".** Name the query keys affected, the server endpoint, and the tests below.
2. **Server first.** The endpoint behaves the same with or without optimism:
   - swap: accepts the client's idempotency key, stores it, and returns the stored result on a repeat
     (`app-state.md`); team route with Staff permission (`security.md`);
   - settings: one field per request, the server stamps that field's `updatedAt`, last arrival wins
     (`app-state.md`).
3. **Before `mutate`:** check connectivity. Offline → fail immediately, show the message, don't call it.
4. **Mutation options:** `networkMode: 'always'`, `retry: 0`; no mutation `scope`; the mutation cache
   is never persisted and paused mutations are never resumed (`app-state.md`).
5. **`onMutate`:** cancel queries for the affected keys, snapshot, apply the optimistic value, disable
   the control (for settings: only that field's control).
6. **`onError`:** restore (settings: only that field, and only if it still holds this mutation's value),
   and show the error.
7. **`onSettled`:** re-enable the control and invalidate the affected queries, so the server's value
   replaces the guess.
8. **Docs:** `STATE.md` records where each piece lives and the last-writer-wins weakness, as
   `app-state.md` requires.
9. **Tests:** `app-state.md` tests 1–6 and 12–14, run on a real device (`AGENTS.md` definition of done).

## Worked example: "Request swap"

Tap → online check passes → `onMutate` cancels the shift queries, snapshots, sets "Swap requested",
disables the button → the request carries a fresh idempotency key → the server times out → error → the
label reverts with a message → `onSettled` re-enables and refetches. If the timed-out request actually
reached the server, the refetch shows the swap. A retry of the same swap request reuses its key, so the
server returns the stored swap instead of creating a second one (`app-state.md` test 2).

**Bug candidate** (`evidence-capture.md`): a double-submitted swap. If it happens, tell Dave to record it
broken before fixing.

## Common mistakes

- Relying on the disabled button alone (a network retry still duplicates).
- A whole-settings snapshot rolled back over a field that changed successfully meanwhile.
- Default TanStack network mode, which pauses offline mutations and sends them later.
- Mutation `scope` for settings (it queues the next change).
- Treating the optimistic value as final.
- The client sending `updatedAt`.
