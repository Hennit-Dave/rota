# 0022: The activity feed: cursor paging, its index, and failing closed

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-27
- **Decided by:** Dave (page size, the rate limit, fail closed and "no cache in this slice" approved 2026-10-26 and 2026-10-27)
- **Related:** slice C2, issue #11, ADR 0021 (the rows the feed reads), `.agents/rules/security.md` (rate limiting), `caching.md`, the `cursor-pagination` skill

## Problem

The feed is a long, growing list (the brief wants it to work at 10,000+ rows and for 200 people at once). It must page without repeating or skipping rows while new activity arrives, stay fast as it grows, and have a stated behaviour when the rate limiter's store (Valkey) is down (issue #11).

## Options considered

1. **Offset paging** (`LIMIT 20 OFFSET 40`). Simple, but the position is a count: when a row arrives while someone scrolls, every later row moves down one, so the next page repeats a row or, after a delete, skips one. It also makes the database read and throw away every skipped row. Rejected (brief).
2. **Cursor on `created_at` alone.** Rows written in the same millisecond share a timestamp, so a page that ends inside such a group either repeats the group or skips the rest of it. Rejected.
3. **Cursor on `(created_at, id)`.** A row is a unique bookmark; "strictly older than this row" has one answer. Chosen.
4. **Fail open when Valkey is down** (serve the feed unlimited, log and alert). Keeps reads up during an outage, but leaves the most expensive read unprotected at the moment protection is gone, with no cache in front of it, and no alerting exists to make "logged and alerted" true. Rejected.

## Decision

**Query.** For one team, newest first by `(created_at DESC, id DESC)`; a page is the rows strictly older than the cursor, `(created_at, id) < (cursor_t, cursor_i)`, with `LIMIT limit + 1`. The extra row only says a next page exists and is never returned. Every query filters by `team_id`; the cursor carries no team.

**Cursor.** Opaque to the client: base64url of `{"t":"<ISO time, ms, Z>","i":"<uuid>"}`, built by the server from the last row returned. Decoding is strict (alphabet, length cap, canonical encoding, exactly the keys `t` and `i`, a time that survives a round trip through `Date`, a canonical lowercase UUID). Anything else is `400 validation_failed` with `invalid_cursor`, and the input is never echoed.

**Page size (approved 2026-10-26).** Default 20, maximum 50 (`ACTIVITY_PAGE_DEFAULT`, `ACTIVITY_PAGE_MAX`). Above the maximum is `400 limit_too_large`. Chosen, not measured.

**Index.** `activity (team_id, created_at DESC, id DESC)`, in migration `20261027120000_add_activity_feed_index`, added **after** the "before" plan was recorded (ADR 0021 deliberately left it out). It matches the filter and the order exactly, so the database reads the first 21 index entries in order instead of every row of the team and sorting them.

| 10,000 rows for one team, shard A primary (test shard), `EXPLAIN (ANALYZE, BUFFERS)` | Before | After |
|---|---|---|
| First page | Seq Scan + top-N sort, 5.5 ms, 269 buffers | Index Scan, 0.056 ms, 3 buffers |
| Deep cursor page (row 5,000) | Seq Scan + sort, 1.6 ms, 264 buffers | Index Scan, 0.057 ms, 4 buffers |

Caveat: the table is small and warm, so the absolute times are not the point; the point is the plan: a full scan and sort become an index read of 21 entries, and the cost no longer grows with the team's history. The full plans are in the pull request.

**Rate limit (approved 2026-10-26): 120 requests per minute per user** (`RATE_LIMIT_FEED_USER_MAX` / `_WINDOW_SECONDS`). **This number was chosen, not measured.** One screen of scrolling is a handful of requests, so 120 a minute leaves a person far more than they need while bounding one account. The load test (200 virtual users) must use **200 distinct test users** so that it measures the feed and not the limiter, and it is where this number gets checked. The limit is checked after the token and session and **before** the membership lookup, so a flood is stopped before it reaches the database.

**When Valkey is down: fail closed (issue #11, decided 2026-10-26).** The feed answers `503 service_unavailable` and returns no rows, like every other limited route. `security.md` no longer says "proposed: fail open", and `caching.md` test 8 says the feed returns 503. Authentication and authorisation never relax.

**No server-side cache in this slice (approved 2026-10-27).** The first-page cache (`caching.md`) arrives with the load-test slice, so the k6 "before" run is genuinely uncached.

## Why

- A row is the only bookmark that cannot move; the tiebreak makes it unique.
- The index is the one thing that keeps the query's cost flat as the table grows, and it is proved by the plan, not assumed.
- Failing closed is the rule everywhere else; the feed is the route where the limiter matters most.

## Consequences

- Paging is stable under new activity: a refresh shows new rows on top, and the rows below are never repeated or skipped (tests).
- A client cannot jump to "page 7": it only follows `nextCursor`. That is how the app scrolls, and what the brief asks for.
- During a Valkey outage the feed is unavailable (503) until Valkey is back; the app shows "Couldn't load activity" with Try again.
- **Known limit, not chased:** the tests prove the order is `created_at DESC, id DESC`, but removing `id DESC` from the query's `ORDER BY` is **not** caught while the index exists, because the index itself returns rows in that order. The wrong direction (`id ASC`) is caught. Revisit if the index is ever dropped or changed.
- The feed reads the team shard's primary for now (as the shift routes do); moving it to the read-routing function (replicas) belongs with that function.
- Revisit when: the load test shows the 120/min limit or the page size is wrong; swaps add new activity kinds; or the first-page cache is added.

## Evidence

- `server/src/activity/activity.integration.test.ts` (11 tests, test shards, real Valkey): pages of the asked size, a null cursor on the last page; ties across page boundaries; new activity while paging causes no repeats or gaps; oversize `limit` and 20 kinds of tampered cursor are 400; another team's cursor reads only the caller's own rows; team isolation across shards (404 identical to an unknown team); a removed member loses the feed at once; the 120/min limit (shrunk in the test) gives 429 with `Retry-After`; Valkey down gives 503 with no rows. Mutation-checked: `<=` instead of `<`, a wrong tiebreak direction and a missing `team_id` filter each fail the right tests.
- `server/src/activity/cursor.unit.test.ts` (4): the codec, the schema, the settings.
- `npm run db:feed-proof -- seed|explain|clean` (test shards only; guarded by `TEST_DATABASE_ALLOWED`): the seed (10,000 rows for one team on shard A, 50 for a team on shard B, half of all rows sharing a timestamp) and the two plans above.
- App: 280 tests; emulator: a 66-row feed paged in four requests across about 30 fast flings (no duplicate requests), the end-of-list card, the empty state, and the error state with Try again recovering once the API was back.
