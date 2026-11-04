# 0038: The team cache: roster, shift calendar and the first page of the feed, in Valkey

- **Status:** accepted (2026-11-04)
- **Date:** 2026-11-04
- **Decided by:** Dave
- **Related:** `.agents/rules/caching.md` (the rules this implements), ADR 0037 (read replicas and the 5 s window), ADR 0022 (the feed), ADR 0018 (half-open Valkey connections), the brief (caching, and the k6 "before and after")

## Problem

The roster, the shift calendar and the first page of the activity feed are read far more often than they change, and the brief asks for caching in Valkey with a
before-and-after load test of the feed. The rules in `caching.md` fix the pattern (cache-aside, generations, a TTL on every key, never anything that decides access
or money). This ADR records how it was built, the numbers chosen, and what was checked.

## Options considered

1. **Cache-aside with random-UUID generations, replaced after the writer's transaction commits** (chosen; it is what `caching.md` specifies). A reader looks up the
   generation, then the entry; a writer replaces the generation. An in-flight old read lands under the old generation, which nobody looks up any more.
2. **Delete the affected keys on every write.** Needs the list of keys (every range, limit and scope), and an in-flight old read can refill a key just deleted. Rejected.
3. **Short TTLs only, no invalidation.** Simple, but every change would be invisible to other users for up to a TTL. Rejected as the main mechanism; the TTL stays as the
   backstop for a failed invalidation.

## Decision

Option 1, in `server/src/cache/`. Three kinds only (`CacheKind` is `roster`, `cal`, `feed`), so nothing else can be cached through it.

- **Read path:** auth and the role check (always the primary) → if this user is inside the 5 s write window, or the process is under 5 s old, **bypass**: skip the cache,
  do not fill → otherwise read the generation, then the entry; a hit is returned; a miss reads the **primary**, stores the result under the generation read before the
  database was, with a TTL. A hit never skips authorisation: the checks run before the cache is asked.
- **Write path:** every writer calls `invalidate(teamId, kinds)` after its transaction commits and before it answers. It sets a **new random UUID** with an expiry and never
  throws. Sites, each with a test: shift create, edit, delete (`cal`, `feed`); swap request and rejection (`feed`), approval (`cal`, `feed`); accepting an invitation (`roster`);
  a paid renewal, which can deactivate the members a reduction chose (`roster`, see "The payment path" below).
- **Keys and scopes** (`caching.md`): `cache:v1:team:<teamId>:<kind>:gen` and `cache:v1:team:<teamId>:<kind>:<generation>:<scope>[:<param>...]`. Roster: scope `team`. Calendar:
  `team`, or `user:<id>` for `mine=true`, with the range as epoch milliseconds (the app asks for day-aligned weeks, so keys repeat). Feed, first page only: `team`, with the validated
  limit and a hash of the (today empty) filters. Later pages are never cached. These responses do not depend on the caller's role, which is why the scope is `team`; **if one ever does,
  its scope must become the role class.**
- **Numbers, all config, all CHOSEN, NOT MEASURED, approved by Dave on 2026-11-04:** entry TTLs feed 30 s, calendar 30 s, roster 60 s; generation TTL 600 s (longer than every entry
  TTL, enforced at startup); stop filling when Valkey's used memory is above 70% of `maxmemory`, checked at most every 30 s.
- **One switch:** `CACHE_ENABLED`. Anything but `true` or `false` stops the process, so a typo cannot leave caching quietly on or off for a load test. Off means nothing is read from or
  written to Valkey, not even an invalidation.
- **Failures never fail a request and never block Postgres.** The cache has its own bounded connection (short timeouts, no offline queue). Any Valkey problem is caught, logged **once per
  outage** (`cache_unavailable`, then `cache_recovered`), and the read falls back to the database. After a failure, reads skip the cache for **5 s** (CHOSEN, NOT MEASURED) instead of each
  waiting out the command timeout; invalidations are still attempted every time. (Both new numbers, this 5 s cool-off and the 30 s fill pause below, are CHOSEN, NOT MEASURED, and Dave approved them on 2026-11-04.) A command that gets no answer on a connection that still says ready replaces the connection (ADR 0018).
  Valkey refusing a write because memory is full under `noeviction` (`OOM command not allowed`) is caught, counted (`cache_write_rejected`) and **pauses fills for 30 s** (the same value as the memory-check interval, `CACHE_MEMORY_CHECK_SECONDS`; CHOSEN, NOT MEASURED); it is not an outage. A failed
  invalidation is logged loudly (`cache_invalidation_failed`), and never undoes or blocks the write.
- **Observable:** every request on the three endpoints logs `cache` (`hit`, `miss`, `bypass`, `off` or `error`) next to `dbRoute`, and a `cache_stats` line every 60 s gives the counters
  and the hit rate (hits over hits plus misses), which the k6 report quotes.

## Why

- The generation order (read it first, replace it after the commit) is the whole correctness argument. It is tested directly: a fill that read old data and lands after an invalidation is
  never served; deleting the generation key gives a new random one that matches no entry.
- **An expired generation can never bring an old one back.** A generation is created with `SET ... NX EX`, always from a fresh `randomUUID()`, never a counter or a timestamp, and entry keys
  contain the generation they were filled under. When a generation expires, the next one is a new random UUID, so every entry filled under the old one is unreachable and expires by its own TTL
  (tested with real random generations: an old entry kept alive past the generation's expiry is not served, and 2,000 generated values have no repeats).
- Valkey is shared with BullMQ (`noeviction`). Measured today: `maxmemory` 298 MB (312,475,648 bytes), 6.47 MB used, 305 keys. The cache is small (a few KB per entry, a handful of keys per team),
  and the guard stops *filling*, never reading, before it could crowd out a queue write.

## The trade-off recorded on purpose: fills read the primary, so the replica is mostly idle for these three endpoints

`caching.md` says a cache fill reads the **primary**, because a fill from a lagging replica would store stale data for a whole TTL. ADR 0037 had just sent these three reads to the replica. So:

- **Cache on:** a miss reads the primary, a hit reads no database, a bypass (the writer's 5 s window, the first 5 s of a process) reads the primary. **The replica is asked for these three endpoints only
  when the switch is off, or when the cache cannot be reached** (a failure falls back to the normal routed read, which is the replica). This was measured over HTTP: with the cache on and replicas
  enabled, the replica's query log did not change for a miss or a hit.
- **Cache off** (the k6 "before" run): the three reads go to the replica, as in ADR 0037.
- This is deliberate (Dave confirmed it on 2026-11-04). The cost: misses add primary load (rare, because a miss happens once per TTL per entry and after a write); the benefit: the cache can never
  serve a stale copy a lagging replica produced. The replica still exists for what is opted in later and as the fallback, and it sleeps while it has no work, which saves Neon CU-hours.

## The payment path

A paid renewal applies a scheduled reduction in the worker (`billing/renewal.ts`), which deactivates members and so changes the roster. `AGENTS.md` says to stop and ask before touching the payment or
ledger path, and rule 13 says a cache failure must never block recording a billing event. So **no file in `billing/` was edited, and no billing test was either.** The worker's composition root
(`worker/main.ts`) wraps the `stripe_event` handler from outside (`cache/workerHooks.ts`): after the handler finishes without throwing, a *successful renewal payment* replaces the team's roster generation.
**Dave gave his explicit OK to this payment-path-adjacent wrapper on 2026-11-04.** It is more than strictly needed (a renewal with no reduction changes no member) and costs one refill a month per team. The
invalidation runs after the commit, never throws, and cannot undo or block anything. If the handler throws, nothing is invalidated and the retry that finishes does it; a crash after the commit but before the
invalidation leaves the job unfinished, so it is retried, finds the payment already applied (`duplicate`), and the wrapper then invalidates.

### Does a failed charge leave members already deactivated? No, so a failed payment invalidates nothing

Asked on 2026-11-04, because a renewal "applies a ready reduction before it charges". What is applied first is the **price**: the reduced plan, seats and amount are frozen onto the renewal attempt, and the
charge is for that smaller amount. **Members are deactivated only when the verified success webhook is applied**, in the same transaction that records the payment, the next period and the ledger rows. Evidence:

- **One statement in the whole server deactivates a membership:** `billing/renewal.ts:463`, inside `applySucceeded`, after it has checked the payment's status, amount, currency, the subscription version and that the scheduled
  change still fits. A search of the source for every write of `deactivated_at` and `deactivatedAt` finds only that line, and the write-site guard (`cache/writeSites.unit.test.ts`) fails on a membership write in any *other* file. (It works per file, so it would not see a second write added inside `renewal.ts`; that file is on its registry, covered by the wrapper.)
- The code that creates the charge (the renewal job, `createRenewalPayment`) and the code that records a failure (`applyFailed`, and the job's own failure path) write no membership.
- The existing renewal test pins the order: `renewal.integration.test.ts`, "a scheduled REDUCTION is applied FIRST, then the renewal charges the smaller amount: the chosen people become inactive only when the payment is
  confirmed". After the charge is created and before the webhook it asserts "Nothing applied before the webhook: members still active, plan unchanged", and only after the success webhook are the chosen members inactive.

So the wrapper's condition (a successful renewal payment) is exactly right: a declined or failed charge changes no member, and the roster cache is still correct. (A *failed-payment with a reduction* case is not pinned by a test of
its own; the guarantee rests on the single write site above. A billing test for it would be a billing-file edit, so it was not added: Dave can ask for it.)

**If the invalidation itself fails** (Valkey down at that moment), the cached roster can list a deactivated member for up to its TTL, **60 s**. That is display only: every access decision reads the primary, so the person
is already a non-member on every team route (the same renewal test asserts a 404 for them straight after the webhook). There is no 5 s window to help here, because the change was made by the worker, not by a user; what
protects the roster is that the invalidation follows the commit within milliseconds.

## Write sites checked and the result

| Site | What changes | Result |
|---|---|---|
| Shift create, edit, delete | calendar, feed | invalidated; tested over HTTP |
| Swap request, reject / approve | feed / calendar and feed | invalidated; a repeat of the same `Idempotency-Key` writes nothing and replaces nothing |
| Accept an invitation | roster | invalidated; tested over HTTP (a pending invitation is not on the roster, so it changes nothing) |
| Paid renewal applying a reduction | roster | invalidated by the worker wrapper (above); the wrapper is unit-tested |
| Create a team | its first membership | **needs none**: the team ID is new and server-made, so nothing can be cached under it yet |
| Member removal, role change | roster | **no such code exists yet** |
| Display-name change | roster, calendar and feed all show names | **no such endpoint exists yet** (settings has no name field) |
| Reduction applied by the boundary job | roster | **it applies nothing** (`billing/reductions.ts`); the renewal applies it (covered above) |
| Invite revoke | invitations list | **not on the roster** (only active memberships are), so nothing to replace |

**A guard for the future** (`cache/writeSites.unit.test.ts`): the test reads the source and fails if any file that writes memberships, shifts, activity rows or a user's display name is not on the
registry with the invalidation that covers it. So a future role change, removal, display-name change (which must replace all three kinds for every team the person is in) or reduction-applying code cannot
forget. The guard is textual and is itself tested against made-up writers (it caught a hole in its own display-name pattern while being written). Seed and proof scripts write rows directly and are exempt on
purpose: their cache entries expire by TTL.

## Consequences

- **Worst case if an invalidation fails:** another user can see stale data for up to one entry TTL (feed 30 s, calendar 30 s, roster 60 s). The writer is protected by the 5 s window, and the failure
  starts the 5 s cool-off during which reads skip the cache, so in practice the stale window starts a few seconds later. After the window the writer can see the stale entry too (tested).
- **For k6:** the cache cannot remove the session check and the role check, which still hit the primary on every request (never cached, by rule). It removes the feed query and the name lookup. The improvement
  will be partial, and the report says so. **A warm-up is needed** (the cold start of ADR 0037, and a first fill per key). Both runs use the same build at the same instance size; the "before" run is the same
  build restarted with `CACHE_ENABLED=false`. The report quotes the `cache_stats` hit rate for the "after" run.
- **Calendar keys are exact ranges.** A client that asks for a different `from` and `to` each time (say "now" to "now plus a week" to the millisecond) gets no hits and fills the cache with entries nobody reuses;
  the TTL and the memory guard bound the damage. Today's app asks for day-aligned weeks in the team's time zone.
- **More than one API instance:** the cache itself is safe (generations live in Valkey, shared by every process). The 5 s bypass is not: it rests on the in-memory marker of ADR 0037, which needs one process.
- **Revisit** when a response starts to depend on the caller's role, when a writer of cached data is added (the guard will say so), or when the k6 numbers show another kind is worth caching.

## Evidence

- `server/src/cache/cache.unit.test.ts` (28): config, keys, hit and miss, a TTL on every entry and generation, the stale concurrent fill, generation loss and expiry, a failed invalidation, the switch, cache-only
  failure, `OOM` handling, the memory guard, the stats line. `writeSites.unit.test.ts` (7) and `workerHooks.unit.test.ts` (4).
- `server/src/cache/cache.http.integration.test.ts` (15): real HTTP, real Valkey, the test shards. Hit and miss on the three endpoints (a hit asks the database for none of the data and answers the same); invalidation at
  every real write site; the writer's 5 s bypass and the process's first 5 s; a failed invalidation (the write succeeds, the writer sees it, another reader sees the old entry until the TTL); keys per limit, scope and range, and
  later feed pages never cached; the cache failing, and Valkey fully down (the feed 503, the others 200); never-cached flows issue **zero** cache commands; the switch off writes nothing; and with replicas, cache off reads the replica
  while cache on does not. Every key in Valkey has a TTL.
