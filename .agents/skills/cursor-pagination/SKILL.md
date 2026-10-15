---
name: cursor-pagination
description: Procedure for Rota's activity feed paging - the server cursor query on timestamp plus ID, cursor validation, the supporting index with EXPLAIN ANALYZE before and after, first-page caching, and the app's infinite scroll with its four list states. Use when building or changing the feed or any other paged list.
---

# Cursor pagination

The requirement is the brief's Requirement 1 (`docs/requirements/ROTA-BUILD-PROMPT.md`; the brief PDF wins
if they differ). Rules it touches: `security.md` (validation, feed rate limit), `caching.md` (first page
only), `data.md` (seeding, routing), `app-state.md` (Lists). Paths are from the repo root.

**First touch:** explain cursor pagination in plain words before the term (`AGENTS.md`), using the brief's
waiter example.

## Steps — server

1. **Plan and wait for "go".** Present the proposed ordering, cursor format and index. The proposal
   below is a starting point, not a decision already made.
2. **Ordering:** newest first by `(created_at, id)`, both descending. The `id` breaks ties so items with
   identical timestamps are neither skipped nor repeated (brief).
3. **Query:** filtered by `team_id`, then "rows strictly older than the cursor":
   `(created_at, id) < (cursor_created_at, cursor_id)`, ordered as above, `LIMIT limit + 1`. The extra
   row only tells you whether a next page exists; never return it.
4. **Cursor:** an opaque string the server builds from the last returned row's `created_at` and `id`.
   Clients never construct it. Propose the encoding in the plan.
5. **Validation** (`security.md`): Zod on route params, `limit` (capped, server maximum is config) and
   cursor (decoded, then each field validated). A tampered cursor → 400.
6. **Pipeline:** team route plus the feed's rate limit, with the fail-closed or fail-open behaviour
   `security.md` currently records (`add-api-endpoint` skill for the rest).
7. **Routing and cache:** reads through the read-routing function (`shard-routing` skill). Only the first
   page may be cached, keyed as `caching.md` specifies; cursor pages never are.
8. **Response:** items, `nextCursor` (null at the end).

## Steps — index and proof

9. **Seed first** (`data.md`, Seeding): the high-volume team on one shard, through the router.
10. **Before:** run `EXPLAIN ANALYZE` on the exact feed query, against the primary of the seeded team's
    shard, as a one-off diagnostic script (never application code). Save the plan output.
11. **Add the index** in a migration on both shards (`data.md`). Propose its columns in the plan so they
    match the filter and ordering of step 3.
12. **After:** the same `EXPLAIN ANALYZE`, same cursor. Save it. Both plans go into the PR and the docs
    (brief: "before and after").

## Steps — app

13. `useInfiniteQuery` with the server's `nextCursor`; FlashList (or FlatList with a written reason);
    pull to refresh (`app-state.md`, Lists; `expo-builds.md` for the FlashList version check).
14. Fetch the next page only when `hasNextPage && !isFetchingNextPage` (brief: no duplicate requests).
15. Design all four states: loading, empty, end of list, error with retry.

## Tests

`security.md` validation test (oversized `limit`, tampered cursor → 400) · `caching.md` key-inputs test ·
`app-state.md` test 16 · plus: items sharing one `created_at` appear exactly once across pages; inserting
new items while paging causes no repeats or gaps; the last page returns a null cursor; another team's
cursor values return nothing from your team (still filtered by `team_id`).

**Bug candidate** (`evidence-capture.md`): rows duplicating on fast scroll. If it happens, tell Dave to
record it before fixing.

## Common mistakes

- Offset pagination, or ordering by timestamp alone.
- `<=` instead of `<` in the cursor comparison (repeats the boundary row).
- Trusting the decoded cursor without validating each field.
- Caching cursor pages, or filtering after pagination (breaks page sizes, `caching.md`).
- Running `EXPLAIN ANALYZE` on the replica or a near-empty table.
- Fetching the next page from `onEndReached` without the `isFetchingNextPage` guard.
