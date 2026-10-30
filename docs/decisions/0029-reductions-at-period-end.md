# 0029: Reductions at the end of the period: choosing who becomes inactive, the boundary check, and inactive members

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-30
- **Decided by:** Dave (P4 + P5 plan, five recommendations accepted 2026-10-30; schema approved: `scheduled_changes` and `memberships.deactivated_at`, test shards first, real shards on his go)
- **Related:** `.agents/rules/money.md` ("Reductions that leave too many members"), `AGENTS.md` rules 1, 2, 3, 8, 9, 10, ADR 0026, ADR 0028, the `background-job` skill

## Problem

An Owner can add seats today (ADR 0028). They must also be able to go down: fewer seats, or a cheaper plan. A decrease must never refund, charge or change anything mid-period, and a team with more people than the new limit must not silently keep paying the old price or silently lose people.

## Options considered

1. **Apply a decrease at once.** Breaks the rule that a reduction takes effect at period end; would need a refund engine. Rejected.
2. **Schedule it with no choice of people; drop the newest members at the boundary.** Surprising and unfair, and it would let software, not the Owner, decide who loses access. Rejected.
3. **Schedule it; the Owner chooses exactly who becomes inactive; a job re-checks at the boundary; P6 applies it.** **Chosen.**

## Decision

**Schema (two additive changes, one migration, both shards).** `memberships.deactivated_at` (a deactivated member is kept, never deleted) and `scheduled_changes` (target, effective date, the chosen people, the fallback acceptance with its wording and time, a status, and what the boundary check found). A partial unique index allows **one live reduction per team** (`scheduled`, `ready`, `blocked`, `continuing`). No foreign key to teams (a team's money history outlives the team row, ADR 0026).

**Quote.** `GET .../change-quote` for a pure decrease is now `supported`, `effect: at_period_end`, with a `reduction` block (effective date, active members, how many people must be chosen, the fallback wording). A change that adds and reduces at once (Team 18 to Business 10) stays unsupported: the sentence says to make the increase first, then schedule the reduction.

**Schedule (`POST .../reductions`, Idempotency-Key, Owner only).** Body `{ plan, seats, selectedMemberIds, acceptFallback }` and nothing else. Under the team row lock: no payment open; the change really is a pure decrease; no reduction already live (409 `reduction_already_scheduled`); and the selection is exactly `max(0, active members - target seats)` distinct, active, non-Owner members. Fewer than needed is 422 `selection_required`; the Owner, a stranger, a repeat or too many is 422 `selection_invalid`. `acceptFallback` stores the wording the Owner saw and the time. The boundary work row (`kind = 'reduction_boundary'`, `run_at` = 00:00 UTC on the period end) commits in the same transaction; only then is it enqueued (rule 9).

**While it is scheduled,** every new invitation and every accept must fit the FUTURE limit as well: members who stay (not the chosen ones) plus pending invitations may not exceed the target seats (409 `seat_limit_reached`). The accept stays the authority, as in ADR 0027.

**Cancel (`DELETE .../reductions/current`)** only while `scheduled`. After the boundary check the Owner can no longer take it back.

**Boundary check (the `reduction_boundary` job).** At the period end it locks the team, re-counts active members who are not chosen, and records `ready` (they fit), `continuing` (they do not, and the Owner accepted the fallback) or `blocked` (they do not and nothing was accepted), with the time and the detail. It logs `NOTIFY_OWNER_PENDING` when the Owner needs to know. **It applies nothing:** no deactivation, no ledger row, no entitlement change. A change that is no longer `scheduled` is left alone, so a replay is harmless.

**Inactive members.** A deactivated member is not a seat (`memberCountOf`), is not in the member list or the team list, and is a non-member on every team route (the middleware answers 404 `not_a_member`, like a stranger). Shift assignment and swaps ignore them. Nothing sets `deactivated_at` in P5; applying the reduction does, in P6.

**App.** The change screen, for a decrease, shows the server's sentence, the people to choose from the member list (never the Owner), and the fallback wording with an accept toggle. The hub shows "Reduction scheduled for <date>" with Cancel while the server says `canCancel`, and the server's sentence after the check. No native build.

## Choices worth knowing

1. **P5 stops at the check.** Applying the reduction, starting the next period and charging for it are renewals (P6), which need the collection flow explained first.
2. **The wording of the fallback is a constant** (`reductionWording.ts`) that the server sends in the quote and stores on acceptance, so what was agreed to is on record.
3. **The Owner notice is not sent.** The push and email notice waits for the push slice (issue #53); P5 shows an in-app banner and logs `NOTIFY_OWNER_PENDING`.
4. **Mixed changes are a documented limit.**
5. **`blocked` has no behaviour yet.** money.md says collection pauses and the team follows the failed-renewal path; that is P6.

## Consequences and limits

- Until P6, a reduction is recorded and checked but never takes effect, and a team passing its period end still cannot change its plan (ADR 0028).
- Deactivation semantics are a security surface: SECURITY.md has a section. Every route that lists or locks team members now filters `deactivated_at IS NULL`; a new query on `memberships` must do the same.

## Evidence

See the PR description: the unit and integration tests on both test shards, and the proof run (schedule, boundary check, cancel) on the test shards.
