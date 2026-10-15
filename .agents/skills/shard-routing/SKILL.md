# Shard routing

Rules: `.agents/rules/data.md` (shard function and its test vectors, global tables, read routing,
read-your-own-writes, pools, migrations, seeding). Paths are from the repo root. Never re-derive the
shard function from memory; use the specification and test vectors in `data.md`.

## Steps

1. **Is the data team-owned or global?** Use the placement list in `data.md` ("Where non-team data
   lives"); the webhook inbox's placement is in `money.md`. Invites are team-owned.
2. **Team-owned:** get `team_id` from the validated route param (never the body), then `getShard(teamId)`.
   New teams get a server-generated `team_id` before their first insert.
3. **Reads:** call the one read-routing function. It returns the primary when the caller has a fresh write
   marker, during startup fallback, or for the primary-required reads `data.md` lists; otherwise the
   replica. **Raw queries use the same function.**
4. **Writes:** the primary, inside one `$transaction` on one shard. Then the read-your-own-writes marker
   (the API process's in-memory map, never Valkey; `data.md`) and
   any cache generation replacement (`caching.md`).
5. **Anything touching both shards** is never one transaction: split it into idempotent steps recorded as
   work rows (`background-job` skill). Invite redemption's ordering in `security.md` is the model.
6. **Migrations:** through the direct URL, applied to shard A then shard B, and confirm both report the
   same list (`data.md`).
7. **Seeding:** through the router, so rows land on the shard their team hashes to. The seeding choice in
   `data.md` (one large team plus a team on the other shard) is what the tests rely on.
8. **Tests:** the routing tests in `data.md`, which check the client that actually ran the query, not only
   the log.

## Worked example: a manager edits a shift, then reloads the calendar

- `PATCH /teams/:teamId/shifts/:shiftId` → `getShard(teamId)` → shard B (say) → transaction on B's primary
  updates the shift and writes an activity row → after commit: marker for the manager, calendar and feed
  generations replaced.
- The manager's reload one second later: the read-routing function sees the marker → B's primary
  (`db_route=primary`, reason `marker`), and the cache is bypassed for them (`caching.md`).
- A staff member reading the same calendar ten seconds later: no marker → cache miss → fill from B's
  primary under the new generation; later hits come from the cache.
- Membership checks on both requests always read B's primary (`primary-required`).

## Common mistakes

- Choosing the shard from anything other than the specified hash of the canonical `team_id`.
- Putting a user's identity rows on the team shard, or team rows on shard A.
- Calling `$replica()` or `$primary()` directly, so raw queries skip the 5-second rule.
- A cross-database foreign key, or a `$transaction` that assumes both shards.
- Running a migration on one shard only.
- Seeding directly into a database instead of through the router.
- Asserting routing only from logs.