# Add an API endpoint

This is a procedure. The rules it follows live in `.agents/rules/` (paths from the repo root); read the
ones each step names instead of relying on memory. If a step and a rule disagree, the rule wins; stop and ask.

## Steps

1. **Plan first** (`AGENTS.md`). Tell Dave in plain words: what the endpoint does, its route type, which
   rules apply, the files you'll touch. Wait for "go".
2. **Classify the route** using the pipeline table in `security.md`: public auth, invite accept, user,
   team, or webhook. A webhook uses the `webhook-handler` skill instead of this one.
3. **Validate the whole request** (`security.md`): strict Zod schemas for route params, query and body.
   IDs as UUIDs, `limit` capped, cursors decoded then validated.
4. **Apply the pipeline for that route type, in its order** (`security.md`): access token and session
   check; applicable rate limits; for team routes, resolve the team from the route param and check
   membership and role against the permission table, read from the primary.
5. **Get data through the shard router** (`shard-routing` skill, `data.md`). Never import a shard's client
   directly. Reads go through the one read-routing function, raw queries included.
6. **Writes:**
   - one transaction on one shard; anything spanning shards becomes work rows (`jobs.md`);
   - after commit: record the read-your-own-writes marker in the API process's in-memory map, never in
     Valkey (`data.md`), and replace any affected cache
     generation (`caching.md`);
   - slow or unreliable follow-up work: write its work row in the same transaction, enqueue after commit
     (`background-job` skill).
7. **Respond** with the shape the app needs; another team's resource → 404, insufficient role → 403,
   validation → 400 without echoing input (`security.md`). Money figures come from server calculations only
   (`money.md`).
8. **Logging:** the request-log fields `observability.md` lists; nothing on its redaction list.
9. **Tests:** the acceptance tests the affected rules files list, plus this endpoint's own: happy path,
   validation failures, wrong role, other team, rate limit where applicable.
10. **Docs in the same PR:** `ARCHITECTURE.md` for new routes or cache scopes, `SECURITY.md` for new
    permissions or rate limits, `STATE.md` if the app's data mapping changes; an ADR for any real decision.
11. **Evidence for the PR** (`git-and-process.md`): the exact HTTP request, its response, and the SQL query
    showing the right rows.
12. **Close the slice** (`AGENTS.md` definition of done): prompt Dave's `LEARNING-LOG.md` paragraph, ask the
    matching interview question, remind him of the daily log.

## Worked example: delete a shift

`DELETE /teams/:teamId/shifts/:shiftId`
- **Type:** team route. **Zod:** both params are UUIDs; no body; no query.
- **Pipeline:** token and session → rate limit if configured → membership and role from the team's shard
  primary → permission table: Owner and Manager may delete; Staff may not.
- **Data:** `getShard(teamId)`; delete inside one transaction, scoped by `team_id` and `shiftId`; write an
  activity row in the same transaction.
- **After commit:** in-process read-your-own-writes marker for the caller; replace the team's calendar and feed
  generations.
- **Tests:** Staff → 403 and the shift still exists; a user from another team → 404, using the seeded
  teams on different shards (`data.md`, Seeding); Manager → success, and the next calendar read misses
  the cache (`caching.md` tests).
- **Evidence:** the request and response, then `SELECT … FROM shifts WHERE id = …` returning no row and
  the activity row present.

## Common mistakes

- Validating only the body.
- Taking the team or user from the body or the token instead of the route and the session.
- Reading roles from the token, or from the roster cache.
- Calling `$replica()` or a shard client directly instead of the router.
- Enqueueing a job before the transaction commits.
- Forgetting cache invalidation or the read-your-own-writes marker after a write, or storing that marker
  in Valkey (`data.md` keeps it in process memory).
- Returning 403 for another team's resource (reveals that it exists).
- Writing the docs "later".
