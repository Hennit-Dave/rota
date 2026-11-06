# Load test report: the activity feed at 200 VUs, before and after caching

Task A requirement: "Load test: 200 virtual users loading the activity feed at once. Report response
times before and after caching." Plan agreed 2026-11-06 (this file is the write-up the load-test
skill calls for once the runs are done).

## Summary

| | Run 1 (no cache) | Run 2 (cache) | Change |
|---|---|---|---|
| Median response time | 2.19s | 1.60s | 27% faster |
| p95 response time | 3.11s | 2.68s | 14% faster |
| Throughput | 47.9 req/s | 56.2 req/s | 17% higher |
| Error rate | 0.08% | 0.03% | lower |

Full numbers, both runs' raw k6 output, the cache hit rate and the Neon budget used are below.

## Environment

Both runs were against the **real, deployed** stack, not local or test shards:

- `rota-api` / `rota-worker` on Northflank, plan `nf-compute-20`, **unchanged size for both runs**.
- Both real Neon shards. Each shard's read replica was raised to **1 CU max** immediately before run
  1 and lowered back to **0.25 CU** immediately after run 2 — never left raised.
- The real Aiven Valkey instance (the deployed queue/cache store).
- k6 v2.3.0 (darwin/arm64), run from Dave's own Mac against `https://api.rota.davebuilds.design`.
- `LOAD_TEST_MODE=true` on `rota-api` for both runs (every k6 request carried `X-Load-Test: k6`), so
  load-induced errors never reached the Sentry Developer-plan quota. Removed after run 2.
- The **only** thing that changed between the two runs was `CACHE_ENABLED`: `false` for run 1,
  `true` for run 2. Same build, same code, same seeded data shape, same instance size.

## Test data and auth (how 200 VUs ran without loosening any rate limit)

One labelled team, **"k6 load test"**, seeded fresh immediately before each run by
`load-tests/seed-k6-team.ts`:
- 200 member users (1 owner, 199 staff), each with a session minted directly through the server's
  own `createSession` + `TokenService.sign` code — **no call to `POST /auth/login` or
  `POST /auth/register`**, so the per-IP login limit and the register limit (confirmed live at
  10/hour per IP — far too tight for 200) were never touched by "logging in" 200 times.
- 10,000 activity rows for the team, same shape as `server/src/db/feed-proof.ts`'s proof data, so
  cursor paging is real rather than a handful of rows that all fit on one page.
- The seed script reads the real, configured `RATE_LIMIT_FEED_USER_MAX`/`WINDOW_SECONDS` live rather
  than assuming them — confirmed **120 requests / 60 seconds per user** both runs.

Each of the 200 k6 VUs uses its own seeded user's token (1:1, `feed-load-test.js`), so no VU ever
shares a rate-limit bucket with another. Each iteration follows a randomized 1–4 pages from the top
of the feed, sized so that even a VU that happened to hit the maximum every iteration stays under
~1.9 req/s — comfortably under the 2 req/s the 120/60s limit allows. The randomization itself matters:
a fixed page count would have every VU re-read the identical top slice of the feed every time, so
most of the 10,000 seeded rows would never be exercised at all.

**A real problem found and fixed before any valid run:** the first seed attempt signed tokens with
local dev's `AUTH_JWT_SECRET`. Every one of 200 VUs got a 401 against the deployed API, because the
deployed `rota-api` verifies against its *own*, deliberately different secret (ADR 0040's
per-deploy-credential approach). Confirmed by decoding a rejected token's claims before touching
anything further: `iss`, `aud`, `exp`, `sub`, `sid` all correct, the session genuinely active in
Postgres — ruling out everything except the signature. Fix: a temporary, local-only
`K6_DEPLOY_AUTH_JWT_SECRET` env var (Dave pasted the deployed value in himself, never synced with the
local secret, never printed anywhere, deleted from `.env` after the runs). The deployed
`AUTH_JWT_SECRET` was then rotated to a fresh value and `rota-api` restarted and confirmed healthy —
recorded in ADR 0040 as well as here.

## Warm-up

Identical for both runs, built into `feed-load-test.js`'s own stages so it can't drift between runs:
ramp 0→10 VUs over 10s, hold 10 VUs for 15s, *then* ramp to the full 200-VU stage. Total active test
time per run: 1m55s (ramp to 200 over 20s, hold 200 for 60s, ramp down over 10s), plus the warm-up.

## Results

### Run 1 — `CACHE_ENABLED=false`

```
THRESHOLDS
  http_req_failed
  ✓ 'rate<0.01' rate=0.08%

checks_total.......: 11214  95.841291/s
checks_succeeded...: 99.91% 11204 out of 11214
checks_failed......: 0.08%  10 out of 11214

http_req_duration..: avg=2.01s min=186.11ms med=2.19s max=4s    p(90)=2.82s p(95)=3.11s
http_req_failed....: 0.08%  5 out of 5607
http_reqs..........: 5607   47.920645/s

iteration_duration.: avg=7.09s min=2.19s    med=6.84s max=13.83s p(90)=11.39s p(95)=11.87s
iterations.........: 2232   19.075955/s
vus_max............: 200

data_received......: 34 MB  294 kB/s
data_sent..........: 976 kB 8.3 kB/s
```

Run 1's 5 failed requests: diagnostic failure-logging (now in the script) wasn't added until after
this run, so their exact status/body is **not known** and can't be retroactively recovered from k6's
side. Given run 2 showed the identical low-magnitude failure mode (below), the likely explanation is
the same transient envoy connection termination — but that's an inference, not confirmed for run 1.

### Run 2 — `CACHE_ENABLED=true`

```
THRESHOLDS
  http_req_failed
  ✓ 'rate<0.01' rate=0.03%

checks_total.......: 13114  112.385876/s
checks_succeeded...: 99.96% 13110 out of 13114
checks_failed......: 0.03%  4 out of 13114

http_req_duration..: avg=1.58s min=177.17ms med=1.6s  max=3.97s p(90)=2.49s p(95)=2.68s
http_req_failed....: 0.03%  2 out of 6557
http_reqs..........: 6557   56.192938/s

iteration_duration.: avg=5.96s min=2.18s    med=5.58s max=13.02s p(90)=9.59s p(95)=10.49s
iterations.........: 2632   22.556018/s
vus_max............: 200

data_received......: 40 MB  344 kB/s
data_sent..........: 1.1 MB 9.1 kB/s
```

Run 2's 2 failures, exact cause captured this time: both `HTTP 503`,
`upstream connect error or disconnect/reset before headers, reset reason: connection termination` —
an istio-envoy-level blip on Northflank's own ingress, not an application error.

**Cache hit rate** (`cache_stats` log line, `rota-api`, read directly from the deployed logs,
screenshots saved):

| Run | 60s window | cacheHits | cacheMisses | cacheHitRate |
|---|---|---|---|---|
| 1 (`CACHE_ENABLED=false`) | 1 | 0 | 0 | n/a — `cacheOff`: 814 requests logged |
| 1 | 2 | 0 | 0 | n/a — `cacheOff`: 1359 |
| 1 | 3 | 0 | 0 | n/a — `cacheOff`: 54 |
| 2 (`CACHE_ENABLED=true`) | 1 | 1095 | 45 | 0.961 |
| 2 | 2 | 1396 | 49 | 0.966 |
| 2 | 3 | 42 | 3 | 0.933 |

Run 1's three `cacheOff` counts confirm caching was genuinely off for that run, not just configured
off with the counter never incrementing.

**Checked against `server/src/cache/store.ts` and `server/src/activity/routes.ts` rather than
assumed:** cursor pages are not counted as cache misses, because they never reach the cache at all.
`routes.ts` only calls `cache.get()` when `cursor === null` (the first page); any page after that
calls `read(false)` directly and returns, bypassing the cache entirely (`caching.md`: "a page after
the first is never cached... too specific to be shared"). So `cacheHits`/`cacheMisses` only ever count
first-page requests - confirmed by the totals: run 2's hits + misses across all three windows
(1140 + 1445 + 45 = 2630) land almost exactly on its 2632 iterations, i.e. close to one first-page
call per iteration, not one per request.

`cacheErrors`, `cacheWritesRejected` and `cacheInvalidationFailures` were all 0 throughout, so the
3-7% miss rate within that first-page-only count isn't cache failures either. The real cause is TTL
expiry: `CACHE_TTL_FEED_SECONDS` defaults to 30s, and every VU in this test shares the same team, the
same `limit=20` and the same (empty) filters, so all 200 VUs' first-page requests land on one shared
cache entry per generation. Over the run's ~90 seconds of active traffic, that entry expires and gets
refilled roughly every 30 seconds, producing a short burst of misses right after each expiry and hits
for the rest of the window - not degraded cache behaviour, just the TTL doing its job.

The ~20 simultaneous misses clustered at each 30s expiry (not spread evenly) are a cache stampede:
every VU whose request lands in that instant misses the same just-expired key and refills it
concurrently, rather than one request refilling it for the rest. Harmless at this scale - Valkey
absorbed it with 0 `cacheErrors`/`cacheWritesRejected` - but the standard mitigation (single-flight
fill, or an early background refresh before the TTL expires) is not implemented; see "what I'd change
next".

A further finding from the request logs themselves: some run 2 requests tagged `"cache":"hit"` still
took 1.2-2.2s, and some of those also carry `"dbRoute":"primary-required"` — inside a writer's 5-second
consistency window, the per-request session/role check still has to run against the primary even
though the feed payload itself came from cache. Caching the feed's first page does not remove that
per-request session-check cost; see "what I'd change next" below.

## What changed, and why

| | Run 1 (no cache) | Run 2 (cache) | Change |
|---|---|---|---|
| `http_req_duration` avg | 2.01s | 1.58s | **21% faster** |
| p90 | 2.82s | 2.49s | 12% faster |
| p95 | 3.11s | 2.68s | 14% faster |
| Throughput (`http_reqs`/s) | 47.92 | 56.19 | 17% higher |
| Error rate | 0.08% | 0.03% | lower |
| Cache hit rate | n/a (off) | 93–97% | — |

Caching only covers the feed's **first page** (`caching.md`: "never cacheable between the server and
the app... the server-side cache of its first page"); every page reached via a cursor goes straight
to the database every time, by design - `routes.ts` never even calls `cache.get()` when a cursor is
present. Each VU in this test follows a randomized 1-4 pages per iteration, but only the first request
of each iteration is cache-eligible; the rest always hit the database regardless of `CACHE_ENABLED`.
That's why the whole-run average improvement is moderate (~15-20%) despite a 93-97% hit rate on the
requests that are actually eligible: most of this test's total request volume is cursor pages,
outside the cache's reach entirely, not a weak cache.

## Neon budget

Free plan: **100 CU-hours per project per month** (confirmed live from neon.com/pricing and the FAQ,
both current as of this test; the allowance is per-project, not account-wide, and resets each billing
period — not shown on the usage page itself, which is why this was checked against Neon's own docs
rather than assumed).

| | Before | After | Used by this test |
|---|---|---|---|
| Shard A | 9.34 CU-hrs | 9.77 CU-hrs | ~0.43 |
| Shard B | 9.26 CU-hrs | 9.68 CU-hrs | ~0.43 |

About 0.4% of each project's monthly allowance for both runs combined. Each replica was raised to 1
CU max only for the run window and lowered back to 0.25 CU immediately after run 2 — confirmed, not
left raised.

## Cleanup

Both runs' seeded data were deleted immediately after use, verified empty by the cleanup script
itself (not just assumed): team + memberships + activity (cascades on team delete), 200 users +
their sessions (`refresh_token_families` confirmed 200→0 both times, a database-level cascade on
user delete, not application code). Nothing else on the real shards was touched by this slice.

## Bottlenecks seen

- Even with caching on, average per-request latency (1.58s) is still high for a single feed page
  under 200 concurrent users — caching the first page helps, but every cursor page still does a real
  query, and this test's randomized depth means most requests are cursor pages. A fuller before/after
  comparison would separate first-page and cursor-page latency rather than reporting one blended
  average (see "what I'd change next").
- Two istio-envoy `503`s per run at this concurrency (Northflank's own ingress, not the app) - a
  small (<0.1%) but real tail worth watching if load ever increases.
- The per-request session/role check still hits the primary on a cache hit when the request falls
  inside a writer's 5-second consistency window (`"dbRoute":"primary-required"` alongside
  `"cache":"hit"` in the request logs) - caching the feed payload itself doesn't remove this cost,
  which is why some cache hits still took 1.2-2.2s.

## Cold-start effects

The warm-up stage (10 VUs, 10s ramp + 15s hold) ran identically before both the no-cache and cached
run, specifically so neither run gets an unfair advantage from a cold connection pool or a replica
waking from idle. No separate cold-start timing was isolated beyond that — both runs' very first
requests are included in the reported aggregates, not excluded.

## What I'd change next

- Tag k6 requests by `first` vs `cursor` page (the script already sets this tag) and report their
  latency and cache-hit behavior separately, instead of one blended average per run — would show the
  cache's effect much more precisely than the current whole-run numbers.
- Expose cache hit/miss as something k6 can see directly (a response header, for example), instead of
  needing a separately-pulled server log line after the fact.
- Separate the latency of a true cache hit (no primary involved) from a cache hit that still pays the
  primary-required session check, instead of one blended "cache hit" bucket - the request logs show
  both exist and likely explain most of the 1.2-2.2s outliers seen among otherwise-fast cache hits.
- Pull `rota-api`'s logs for run 1's exact failure window, now that it's clear from run 2 what to look
  for (503s from istio), to confirm run 1's 5 failures were the same thing rather than inferring it.
- Fix the stampede at each TTL expiry: either a single-flight fill (the first miss fills, everyone else
  waits on that result instead of all refilling) or an early background refresh shortly before the TTL
  ends, so no request ever has to wait on a fill at all.
- Investigate issue #79 (the worker's ~5-minute Valkey reconnect pattern) for whether it's related to
  the istio connection-termination 503s seen here - both are intermittent connection-layer blips on
  the same deployed services, found in the same week, and might share a cause.
