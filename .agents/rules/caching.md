---
trigger: model_decision
description: "Read before caching anything in Valkey: team rosters, shift calendars, the activity feed's first page, cache keys, generations, TTLs, invalidation, or turning caching off for the load test."
---

# Caching

If a rule here conflicts with `AGENTS.md`, stop and ask. The tests at the end are the acceptance criteria.
Valkey is shared with BullMQ and rate limiting (`jobs.md`, `security.md`).

## Pattern: cache-aside (brief)

1. Read the cache. On a hit, return it.
2. On a miss, fill: capture the current generation, read the database, store under that generation with a
   TTL (below).
3. On a write, replace the generation **after the database transaction commits**, before responding.

- **Cache fills read from the primary.** *Why: a fill from a lagging replica would store stale data.*
- **Read-your-own-writes bypasses the cache.** During a user's 5-second post-write window, and during the
  startup fallback (`data.md`), their reads skip the cache entirely and go to the primary, and they don't
  fill it. *Why: if an invalidation failed, a stale entry could otherwise be served to the very user who
  just wrote.*
- **Cache operations fall back to the database, but mandatory authentication, authorisation and
  rate-limit checks still apply.** If only the cache fails, serve from the database and log it. If Valkey
  is down entirely, rate-limited routes fail closed as `security.md` says (the feed returns 503).

## Generations, not counters

Each cached dataset has a generation key: `cache:v1:team:<teamId>:<kind>:gen`.

- A generation is a **random UUID**, never a counter or timestamp. *Why: a recreated counter or a
  millisecond value can collide with an earlier one still referenced by live entries.*
- **Create** a missing generation atomically with `SET <genKey> <new UUID> NX EX <genTtl>`, then read it
  back. **Replace** it on invalidation with `SET <genKey> <new UUID> EX <genTtl>`. Both always carry the
  expiry. `genTtl` (config) is longer than any entry's TTL; if a generation expires, a new random one simply
  starts. Entries are written with `SET <entryKey> <value> EX <entryTtl>`.
- **Every entry key contains the generation it was filled under.** A fill reads the generation **before**
  it reads the database. If an invalidation replaces the generation while the fill is reading, the fill's
  result lands under the old generation, which no reader looks up any more, and it expires. *Why: this is
  what stops an in-flight old read from refilling the cache after invalidation.*
- Old entries are never deleted one by one; they expire.

## What we cache, and what goes in the key

**A key includes every input that shapes the response.** Never cache one shared page and filter it per
user: filtering a page after pagination breaks page sizes and cursors.

| Data (kind) | Key | Generation replaced by |
|---|---|---|
| Team roster (`roster`) | `cache:v1:team:<teamId>:roster:<gen>:<scope>` | Any membership or role change |
| Shift calendar (`cal`) | `cache:v1:team:<teamId>:cal:<gen>:<scope>:<from>:<to>` | Any shift create, edit, delete, or swap approval |
| Feed, first page only (`feed`) | `cache:v1:team:<teamId>:feed:<gen>:<scope>:<limit>:<filtersHash>` | Any new activity |

- **`scope`** is the visibility class the endpoint's response depends on: a role class (e.g. `owner`,
  `manager`, `staff`) when everyone with that role sees the same thing, or `user:<userId>` when the
  response is personal. Each endpoint's scope is written down in `ARCHITECTURE.md` before it is cached.
- `limit` and filters are the **validated, normalised** values (`security.md`); `filtersHash` is a hash of
  the normalised filter object. Calendar ranges are capped (config), so entries have a bounded size.
- Cursor pages after the first are never cached.
- A cache hit doesn't skip authorisation: the request has already passed membership and role checks
  before the cache is read.

## TTLs and memory

- **Every key has a TTL** (config per kind, recorded in `ARCHITECTURE.md`). Never `SET` without one.
- **If an invalidation fails,** stale data can be served for up to the entry TTL. The writer bypasses it
  during the 5-second post-write window; after that window the writer can see it too, until it expires.
  Record that worst case; keep TTLs short.
- Watch Valkey memory. Caching must never crowd out the queue: near the limit, stop filling rather than
  risk BullMQ writes being rejected.

## Never cache

- Brief: active subscriptions, payment status, credit balances, webhook idempotency records.
- Ours: sessions, token state, memberships and roles **for permission checks**, password-reset,
  magic-link and invite tokens, settings used to decide quiet hours. *Why: these must reflect the latest
  write (`data.md`, `security.md`).* The roster cache is for display only.

## Load test (brief: before and after caching)

One config switch turns caching off, so the same build runs the "before" and "after" k6 passes against
the feed. The report says which was which and gives the hit rate during the "after" run.

## Tests (acceptance criteria)

1. **Hit and miss:** the first read misses and fills from the primary; the second hits.
2. **Calendar and roster invalidation:** edit a shift, or change a role → the next read misses and shows it.
3. **Concurrent stale fill:** start a fill, let it capture the generation and read old data; invalidate;
   let the fill write → the next read still misses and returns fresh data.
4. **Generation loss:** delete a generation key while entries exist → the new random generation matches
   none of them.
5. **Failed invalidation:** make the generation replace fail after a write → the writer's reads within 5
   seconds bypass the cache and see the write; another user may see the old entry, and it expires by TTL.
6. **Key inputs:** feed requests with different `limit`, filters, or visibility scope never share an entry;
   each returns its own correct page and cursor.
7. **TTL everywhere:** after a test run, every `cache:*` key has a TTL.
8. **Cache-only failure:** the cache client fails while rate limiting works → requests succeed from the
   database. **Valkey fully down:** the feed returns 503 (rate limiter fails closed, `security.md`; decided in issue #11, ADR 0022).
9. **Never-cache:** subscription status, permissions and token checks never read from Valkey (instrumented).
10. **Switch:** with caching off, no `cache:*` keys are written.
