# Sharding

Rota splits its data across **two separate PostgreSQL databases** (two Neon projects, shard A and shard B).
Each team's data lives on one of them, chosen by a hash of `team_id`. This file explains the key, what is
pinned to shard A, how a very large team would be handled, and which queries got harder.

Source of truth for the rules: `.agents/rules/data.md`. Decision record: `docs/decisions/0002-database-foundation.md`.
Where this file says **built**, the code exists in `server/src/db/`. Where it says **planned** or **not built**,
it is a rule or a design with no code yet.

## The shard key: `team_id`

Almost everything Rota stores belongs to a team: memberships, shifts, swaps, activity, billing, the ledger.
Keying on `team_id` keeps one team's data together, so a team's roster or activity feed needs one database,
not both. The server generates `team_id` before the first insert, because the shard is chosen from it and
must be known before any row is written.

### How the hash picks a shard (built: `server/src/db/shard.ts`)

1. `team_id` is a UUID in canonical form: lowercase, hyphenated, 36 characters. Anything else is rejected.
2. Encode the string as UTF-8 bytes and take SHA-256.
3. Read the first 4 digest bytes as an **unsigned big-endian** 32-bit integer.
4. That integer mod 2: 0 is shard A, 1 is shard B.

Every process computes the same answer, across restarts. It aims for an even spread and does not guarantee a
perfectly even one. Changing the function can move teams between shards, so it never changes without an ADR
and a migration plan.

**Test vectors** (from `data.md`, checked in `server/src/db/shard.test.ts`):

| `team_id` | First 4 bytes | Integer | Shard |
|---|---|---|---|
| `00000000-0000-4000-8000-000000000001` | `11e594f4` | 300258548 | A |
| `00000000-0000-4000-8000-000000000002` | `e79acd97` | 3885682071 | B |
| `3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b` | `5b9edf31` | 1537138481 | B |

### One router (built: `getShard` in `server/src/db/clients.ts`)

All team-scoped access goes through `getShard(shards, teamId)`, which returns that shard's clients. Nothing
imports a shard's client directly. Replica clients and the read-routing function are **not built** yet
(build-order step 5); today each shard has a primary client only.

## What lives only on shard A, and why

**Built:** `users`, `credentials`, `refresh_token_families`, `refresh_tokens`, and `user_teams` (the user-to-teams
directory, below). **Planned** (named in `data.md`, no code yet): user-level settings, and a lookup from invite token
hash to `team_id` if one is needed to find the invitation on its team's shard.

Why identity is not sharded by team: a person exists before they belong to any team, and may belong to
several. At login there is no `team_id` to hash, so identity needs one fixed home. Shard A is that home
(`server/src/db/identity.ts`, `identityDb`). Every identity read uses the **primary**, because a logout or a
detected token theft must stop the very next request (ADR 0005).

The same migrations run on both shards, so the identity tables also exist on shard B. Nothing writes to them
there.

**Known imbalance.** Shard A carries the identity load on top of its share of teams. The heaviest part is not
the number of rows: every authenticated request re-checks the session on shard A's primary
(`docs/ARCHITECTURE.md`, section 5). This load does not depend on how teams are split between the shards.

The team's own shard holds the team row, memberships, roles, shifts, swaps, activity, billing and the ledger (built so far:
`teams` and `memberships`). Invites belong to the team, so the authoritative invitation lives on the team's shard.

## Hot-shard risk and a very large team

**Where the key fails.** Keeping a team together is the point of the key, and also its weakness. One very
large team sends most of its traffic to whichever shard it hashes to, while the other shard sits idle. The
hash balances teams, not traffic. `team_id` also does nothing for data that has no team, which is why identity
needed its own rule.

**Mitigation (documented, not built):** move that team to its own shard through a **directory override**, a
short list of `team_id` to shard that is checked before the hash. The hash function itself does not change, so
no other team moves.

Moving a team means copying its rows to the new shard and then switching the override, as work rows that can be
repeated safely (`data.md`: no transaction spans two shards). That procedure is not designed here. A third
database is new infrastructure and must stay on a free plan (`AGENTS.md`, Stack) before anyone builds it.

**Open question: where the override directory lives.** The likely option is shard A. The list would be tiny,
so the API loads it from shard A at startup and holds it in memory, which means no per-request lookup on A. The
trade-off is that a changed override needs a reload or a restart before it takes effect. Two things to settle
when this is built: the worker is a separate process that routes by shard too, so it needs the same list, and
a team being moved must not be written to by two shards while the override is half-applied. Not decided.

## Queries that got harder

What is known now. **This list will grow as teams, shifts and the activity feed land**, and each new
cross-team or cross-shard query should be added here in the PR that introduces it.

| Query | Why it is harder | Handling |
|---|---|---|
| A user's teams | The user is on shard A, but memberships are on each team's shard, so one user's teams can span both shards. | **Built (ADR 0013).** A directory table `user_teams` on shard A is a lookup hint; `GET /teams` reads it, then verifies each team against its own shard's memberships, one read per shard that appears. Written directory-first when joining and membership-first when leaving, so it may over-report (an inert orphan) but never under-report. Orphans are swept by a follow-up job (issue #33). |
| Listing a team's members with their names | Memberships are on the team's shard, names are on shard A. | **Built.** Memberships from the team's shard, then ONE batched `WHERE id IN (...)` on shard A, never one query per member. |
| Admin totals and global search | They cross teams, so they cross shards. | Not designed yet. Anything across teams is a fan-out to both shards. |
| A reference from a team row to a user | A row on one shard cannot point at a user on shard A with a database constraint. | No foreign keys across databases. The application checks the reference. |
| A write that touches both shards | `$transaction` is atomic within one shard only. | Split into separate steps that can safely be repeated, recorded as work rows (`jobs.md`). |
| Finding an invitation | The invite belongs to the team's shard, but the person holding the token does not know the team. | **Solved without a lookup table (ADR 0015).** The link carries `<teamId>.<secret>`; the team ID is a routing hint that picks the shard, and the query is `WHERE team_id = ? AND token_hash = ?`. An unknown or wrong team ID finds nothing and answers like every other unavailable invite. It also survives a team moving to its own shard. |
| Schema changes | Both shards must stay identical. | Migrations deploy A then B and `npm run db:parity` compares the applied lists. A migration that reaches only one shard blocks further work. |

## Built vs not built

| Item | State |
|---|---|
| Shard function and the three test vectors | Built, tested |
| `getShard` router, primary clients for both shards | Built |
| Identity on shard A through the primary | Built |
| Migration parity check across both shards | Built |
| Read replicas and the read-routing function | Not built |
| Teams, memberships and the user-to-teams directory (create, get, list, members) | Built, tested on the test shards |
| Invitations and their email work rows, written together on the team's shard | Built, tested on the test shards, including a lost invite email on shard B recovered by the sweep |
| Shifts, swaps, activity feed | Not built |
| Directory override for a very large team | Not built, documented above |
