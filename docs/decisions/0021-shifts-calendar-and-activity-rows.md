# 0021: Shifts, the calendar, and the activity rows written with them

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-26
- **Decided by:** Dave (overlap rule, 42-day range cap and the two lock choices approved 2026-10-26)
- **Related:** slice C1, `.agents/rules/data.md`, `security.md` (permission table, threats 1 and 2), ADR 0013 (team directory and shard rules), ADR 0014 (team routes), Figma 04 "Calendar & activity"

## Problem

Owners and Managers need to publish shifts and staff need to see them. The brief's "Staff calls delete-shift" test needs a real delete endpoint. The activity feed (the next slice) needs rows to show, and those rows are only trustworthy if they are written in the same transaction as the change they describe.

## Options considered

1. **Shift status column (draft / published / cancelled).** Figma's "Scheduled" suggests a state. No frame shows a draft, a cancelled shift or a way to move between them, so the column would hold one value for ever. Rejected for now: a shift that exists is scheduled; a deleted one is gone.
2. **Soft delete.** Keeps the row, forces every query to remember `deleted_at IS NULL`, and one forgotten filter shows a deleted shift. Rejected: deletion is a hard `DELETE`, and the history lives in `activity`.
3. **Overlap rule by database constraint** (`EXCLUDE USING gist` on a time range). Exact, but needs the `btree_gist` extension and a range type Prisma cannot model, so the schema and the migration would drift apart. Rejected.
4. **Overlap rule by a lock plus a check inside the transaction.** Chosen.
5. **A session-level advisory lock** to serialise the check. Not allowed through the pooler (`data.md`, `server/AGENTS.md`).

## Decision

**Tables** (team shard, with the team; no cross-database foreign keys):
- `shifts`: `title`, `area?`, `starts_at` / `ends_at` (`timestamptz(3)`: UTC instants at millisecond precision, so cursors and JavaScript dates agree), `break_minutes?`, `note?`, `assigned_user_id?` (null is an open shift), `created_by_user_id`. CHECKs: `ends_at > starts_at`, `break_minutes >= 0`. Indexes `(team_id, starts_at)` and `(team_id, assigned_user_id, starts_at)`.
- `activity`: `team_id`, `created_at`, `actor_user_id`, `kind` (`shift_created`, `shift_updated`, `shift_deleted`), `shift_id?` (**no foreign key**, so history outlives the shift), `data` jsonb (a snapshot: title, times, assignee, and for an update the names of the fields that changed). The feed's index and cursor query are the next slice (ADR 0022): it is deliberately not here, so its `EXPLAIN ANALYZE` has an honest "before".

**Routes** (`/teams/:teamId/shifts`): `GET` (range list), `GET /:shiftId`, `POST`, `PATCH /:shiftId`, `DELETE /:shiftId`. Every route: Zod on params, query and body (strict), token and session check, `requireTeamRole`. `shifts.view` is every role; `shifts.edit` is Owner and Manager. Every query is scoped by `team_id`, so another team's shift ID is a 404 under my team's path. The list takes `from`, `to` and `mine`, returns shifts that overlap `[from, to)`, soonest first, and refuses a range over **42 days** (approved: six weeks, enough for a month grid; `SHIFTS_MAX_RANGE_DAYS` overrides it).

**Overlap rule (approved).** One person cannot have two overlapping shifts: `409 shift_overlap`. Touching shifts (one ends when the next starts), different people and open shifts are fine. The check and the write run in one transaction that first takes a `FOR UPDATE` lock on the **assignee's membership row** in that team, so two requests for the same person queue one behind the other. This also proves the assignee is a member (a stranger or a member of another team is `400 not_a_member`). Five simultaneous requests for the same person and time give exactly one shift (test).

**Activity rows.** Every create, update and delete is one transaction: the change and its `activity` row commit together or not at all.

**Time.** The server stores and returns UTC instants only. What "Thursday" and "09:00" mean is the **team's time zone**, so the app converts with `Intl` using the team's IANA zone (the day keys of the week strip, the greeting, the typed times). The app sends a week as `[Monday 00:00, next Monday 00:00)` in that zone; across a daylight-saving change a week is 167 or 169 hours, which the tests cover.

**What the app may hide.** `GET /teams/:teamId` now also returns `canEditShifts` (from the permission table), so the app shows "Create shift", "Edit" and "Delete" only to those who may. The server decides again on every write.

## Why

- A lock on a row that already exists (the membership) is the smallest tool that works through the pooler; nothing else is held after the transaction.
- Writing the activity row with the change removes a whole class of "the feed disagrees with the data" bugs and needs no queue (so none of the queue-loss concerns of `jobs.md` apply to it).
- UTC in, UTC out keeps the server free of display rules; the one place that knows the team's clock is the app's `shiftTime.ts`, which is unit-tested across zones and a clock change.

## Consequences

- Deleting a shift loses its row but not its history; the feed can say "Tunde Bello's 10:00-16:00 Kitchen prep was deleted".
- The overlap rule is enforced in code, not by the database. A future writer of `shifts` that skips `assertNoOverlap` can break it; all writes go through `service.ts`.
- No notification is sent when a shift changes: push arrives in a later slice, so the screens say "Assigned staff will see it on their schedule" rather than the Figma wording "Notifications will be sent".
- Typed dates and 24-hour times replace the native pickers in Figma, because a native date picker is a native module and would force a new EAS build. Revisit when the next build is needed anyway.
- Revisit when: a draft state is designed, shifts need repeating patterns, or a month grid needs more than 42 days.

## Evidence

- `server/src/shifts/shifts.integration.test.ts` (16 tests, test shards, real Valkey): the brief's Staff-delete test (403, and the shift and its history untouched); team isolation across both shards; another team's shift ID is 404; the activity row commits with the change; overlap and the five-way concurrency test; the 42-day cap at the exact boundary; the validation battery; role read from the database (demote, same token, next request refused). Mutation-checked: removing the `team_id` scope from delete, and loosening the delete permission to Staff, each fail the right tests.
- `server/src/shifts/shifts.unit.test.ts` (7): the settings and the schema refinements.
- `app` tests: `shiftTime` (zones, daylight saving, week windows), the API paths and bodies, the form rules, failure mapping, recolouring of the Figma icons.
- On a device (emulator, local API, test shards): the schedule as an Owner and as Staff, a clashing shift refused with the overlap message, a shift published and shown, a shift deleted. Screenshots are kept outside the repo and linked in the pull request.
