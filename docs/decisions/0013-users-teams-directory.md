# 0013: A user's teams: a directory on shard A, written first and removed last

- **Status:** accepted (2026-10-23; Dave approved the plan, including this exception to the work-row rule, and added the removal rule)
- **Date:** 2026-10-23
- **Decided by:** Dave
- **Related:** `.agents/rules/data.md` (sharding, "No foreign keys across databases"), `docs/SHARDING.md` ("queries that got harder"), ADR 0002, ADR 0014, `.agents/skills/shard-routing`

## Problem

A user lives on shard A. Their memberships live on each team's shard, chosen by the hash of `team_id`. "Which teams am I in?" is asked on
every app launch, and one user's teams can be on both shards. `SHARDING.md` listed it as "not designed yet". No transaction can span the two
databases, and there is no foreign key between them.

## Options considered

1. **Ask both shards every time** (`memberships WHERE user_id = ?` on A and on B). Always correct, no new table. But every launch wakes both
   Neon computes and spends CU-hours on the free plan, and the cost grows with every shard added.
2. **A directory table on shard A, written as a work row after the membership.** One cheap lookup. But a work row runs after the main write,
   so a team the user has just created would not appear until the worker ran, and the app would show "no team" right after "create team".
3. **A directory table on shard A, written synchronously in a fixed order** (chosen). One shard-A read, then one read per shard that
   actually appears, each verified against that shard's memberships.

## Decision

`user_teams (user_id, team_id)` lives on shard A. It is a **lookup hint, never proof of membership**. The membership on the team's shard stays
the only authority, and every read of the directory is verified against it.

The one invariant: **the directory may over-report but must never under-report.** Two write orders keep it true:

- **Joining (create team, accept an invite):** write the `user_teams` row **first**, then the membership. A crash between them leaves a
  directory row with no membership: an inert orphan.
- **Leaving (leave, removed by a manager):** delete the membership **first**, then the `user_teams` row. A crash between them leaves the same
  harmless orphan. Never the other way round: deleting the directory row first and then failing would leave a member the user can no longer find.

The directory insert is idempotent (`ON CONFLICT DO NOTHING`), so a retry is safe.

## Why

- This is a deliberate exception to `data.md`'s "cross-database writes are idempotent steps recorded as work rows" (data.md is amended in the
  same PR). A work row is for follow-up work. Here the cross-database step must happen **before** the main write, and the failure it
  leaves behind is harmless by construction, so a work row would add a queue, a delay and a failure mode for nothing.
- Orphans are inert because reads verify: `GET /teams` takes IDs from the directory and keeps only those with a membership on the team's shard.
  Access to a team never consults the directory at all: it checks the membership on the team's shard primary (`security.md`).
- Tested, not assumed: a failed team insert leaves an orphan that is not listed; a membership with no directory row is not listed (that is
  the writer breaking the rule, and the test shows what it would cost); a removed member loses access while the directory still lists them.

## Consequences

- Making it easier: "my teams" is one shard-A read plus one read per shard that appears, and a user with teams on one shard never wakes the other.
- Making it harder: **every membership writer must follow the two orders.** Invite acceptance and member removal (later slices) must; a membership
  written without its directory row would be invisible to the user's team list. That is the cost of the invariant, and the reason for this ADR.
- Orphans accumulate (a failed create, a crash while leaving). They cost a few bytes and one wasted lookup. **Follow-up:** a sweep that deletes
  directory rows with no membership behind them (tracked as a GitHub issue).
- Shard A carries one more small table. It is a known extra load on A (`SHARDING.md`).
- Revisit when: teams per user grows enough that listing needs paging, or when a third shard changes the cost of the fan-out in option 1.

## Evidence

`server/src/teams/teams.integration.test.ts` (shard placement by SQL, orphan not listed, membership without a directory row not listed, the
members query batched) and `team-security.integration.test.ts` ("a removed member loses access ... directory still lists them"), on the test
shards.
