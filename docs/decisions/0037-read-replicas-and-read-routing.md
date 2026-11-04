# 0037: Real read replicas, and a single function that decides every read

- **Status:** accepted (2026-11-04)
- **Date:** 2026-11-04
- **Decided by:** Dave
- **Related:** issue #15 (closes), `.agents/rules/data.md` (Prisma clients and pools, Read-your-own-writes), brief p15 (Replication), ADR 0002

## Problem

The brief asks for a read replica if the plan offers one, otherwise a second read connection string, with read queries routed to it in code,
a written "what changes in production", and read-your-own-writes either way. We need to know which of the two we have, and how to route
without quietly moving reads that must never lag (sessions, permissions, billing).

## Options considered

1. **Real Neon read replicas, with `@prisma/extension-read-replicas`, and the extended client handed out as the shard's client.** The documented way.
   Risk (found in the spike): once a client is extended, *every* plain model read on it (`findMany`, `findFirst`, `count`...) goes to the replica.
   Today `shards.X.primary` is used by all of auth, billing, permission checks and the worker, so that would silently move hundreds of reads.
2. **Real replicas, but `primary` stays the plain client and the extended client is reachable only through one routing function** (chosen).
   A read uses a replica only if its route handler opts in.
3. **A second connection string to the primary** (the brief's fallback). Not needed: Neon Free offers "Add read replica" on both projects
   (Dave checked both dashboards, 2026-11-04, screenshots saved).

## Decision

Option 2.

- **Replicas:** one per Neon project (shard A, shard B), created by Dave in the dashboard: autoscaling capped at **0.25 CU** (raised only for the k6 run,
  then put back), the **pooled** (`-pooler`) host, scale-to-zero after 5 minutes (not configurable on Free). One replica per *project* serves every
  database in it, so the same replica serves `neondb` (real) and `rota_test_a` / `rota_test_b` (tests). Env names: `SHARD_A_READ_URL`,
  `SHARD_B_READ_URL`, `TEST_SHARD_A_READ_URL`, `TEST_SHARD_B_READ_URL` (the same role and password as the primary, only the host differs).
- **Clients (`server/src/db/clients.ts`):** `shards.X.primary` is the **plain** client and always reads the primary. The API alone also gets
  `shards.X.reader`: the primary extended with `$replica()` over a replica client (pool of 5, connection timeout 8 s). The worker passes no
  `replicaMax` and has no replica client (data.md: it uses primary clients only).
- **The one routing function (`server/src/db/readRouting.ts`):** `reads.run(teamId, ctx, read)` chooses the database for an opted-in read, in this order:
  `primary-required` (the caller says so) → `marker` (this user wrote less than 5 s ago) → `startup` (this process is less than 5 s old) → `none`
  (the replica). The reason goes on the request log as `dbRoute`. Raw SQL runs on whichever client it is handed, so `$queryRaw` on the replica client is
  a replica read; the activity feed's raw cursor query is routed this way.
- **The marker (read-your-own-writes):** an in-process `Map` of user ID to commit time. Express middleware records it for the signed-in user on every
  non-safe request (POST, PATCH, DELETE...) *just before the response headers are written*, so it exists before the client can send its next request.
  Expired entries are removed when read and by a sweep every 5 s (no I/O). **The marker is in memory, so it only works while there is exactly one API
  process and a deploy stops the old process before it starts the new one (stop-then-start).** A second instance would not know about the first one's
  writes, and a rolling deploy (old and new overlapping) would break the startup window that covers a restart. This is why the deployment gate in
  `AGENTS.md` requires stop-then-start to be confirmed on the host before read-your-own-writes is marked done, and why `ARCHITECTURE.md` lists it under
  "What changes in production".
- **Opted in (first PR):** the shift calendar (`GET /teams/:teamId/shifts`), the activity feed (`GET /teams/:teamId/activity`) and the roster
  (`GET /teams/:teamId/members`). The caller's role and membership are still checked on the primary first. **Everything else stays on the primary,
  by default**: the session check, refresh tokens, permission checks, invitations, billing and the ledger, settings, swaps, single-shift reads, and the
  user-name lookups on shard A.
- **A replica that cannot be reached falls back to the primary; a query error does not.** Only connection and timeout errors are retried on the primary:
  the database was unreachable, the connect timed out, or the connection was reset (Prisma's driver-adapter kinds `DatabaseNotReachable`, `ConnectionClosed`,
  `SocketTimeout`, `TlsConnectionError`, `TooManyConnections`; pg's own connect-timeout and "terminated unexpectedly" errors; Node socket codes such as
  `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`). The failure is logged (`replica_read_failed`), the read is repeated on the primary, and the route is
  `replica-failed`. A read is safe to repeat, so a caller is not given a 500 because the replica was down. **An error the replica returned for the query** (a missing
  table, bad SQL, a constraint) **is not retried**: the primary would fail the same way, and quietly re-running it would hide a bug. It reaches the caller and the
  route stays `none`. Prisma 7 with `adapter-pg` reports a refused connection and a bad query under the same `P2010` code, so the classifier looks at the kind
  inside `meta.driverAdapterError.cause` (shapes observed in a spike, names checked in the installed packages). A wrong password (`AuthenticationFailed`) is not
  retried either: it is a configuration fault to surface.

## Why

- Option 1's default is the wrong way round for a system whose correctness rules say "authorisation reads come from the primary": it makes the replica
  the default and the primary an exception someone must remember. Option 2 makes the primary the default and the replica a deliberate choice that
  appears in the diff of the route that makes it.
- The spike (kept in the evidence folder) showed the extension works with Prisma 7 and `@prisma/adapter-pg` (0.5.0, peer `@prisma/client ^7`):
  model reads on the extended client went to the replica, `$queryRaw`, writes and both `$transaction` forms went to the primary, `$primary()` and
  `$replica()` went where they say, and extending did not change the plain client.

## Replica lag, measured (test databases, 15 samples per shard, 2026-11-04)

A commit on the primary was followed by polling the replica until it had replayed that WAL position. Shard A: median 130 ms, range 122 to 155 ms.
Shard B: median 122 ms, range 114 to 146 ms. The round trip from the test machine to the replica alone (`select 1`) is a median of 133 ms (A) and 146 ms
(B), so **every sample was done within about one round trip: the replica had already replayed the commit by the first poll, and the lag is below what this
measurement can resolve.** It is not zero, and it will be larger under load. What it means for users:

- The user who wrote reads the primary for 5 s, so they never see the lag.
- *Another* user can read a replica copy that is a fraction of a second behind: for example a Staff member opening the calendar the instant a Manager
  publishes a shift may not see it for that fraction of a second. This is the accepted, documented trade of the brief's design.
- **Cold start:** a replica that scaled to zero (5 minutes without a query, not configurable on Free) wakes on its first query. That took 1.4 to 2.5 s once,
  and the first test run needed up to about **6.5 s** for its first four queries across both shards (which also woke the primaries). The 8 s connection
  timeout is **chosen, not measured**; past it the primary answers. **k6 needs a warm-up before it measures**: a few requests that wake both replicas and
  both primaries, so the first seconds of cold-start latency are not counted as the cache's or the replica's cost. The report states the warm-up and
  that the replicas were awake.

## Consequences

- **Neon budget:** a replica is a second compute that draws on the same per-project CU-hours as the primary (`data.md` records 100 per project; the
  dashboard is the authority). It sleeps after 5 minutes without queries. The k6 run is the moment to watch it.
- **Connections:** the API has up to 5 + 5 per shard (data.md pool table), the worker 3 per shard primary.
- **Tests:** the shared test kit builds shards **without** replicas by default, so no existing suite races replication lag; replica behaviour is proved in
  `readRouting.integration.test.ts` and `readRouting.http.integration.test.ts`, against the real replicas.
- **Deploy:** the deployed API needs both `*_READ_URL` values and refuses to start without them. Because roles are project-wide in Neon, the replica accepts
  the deploy-only role created for the deployed API, with no extra step.
- **Revisit** when: there is more than one API instance (the marker must then become a position-based check), when the replica's CU-hours matter, or when
  more endpoints are opted in (each one is a conscious change, and the k6 report says whether they helped).

## What changes in production

(Also in `ARCHITECTURE.md`.) With more than one API instance the in-memory marker no longer works: a write handled by instance 1 would not be known to
instance 2. Replace it with a position-based check, comparing the replica's replay position with the WAL position of the user's last write (stored in
Postgres or the session). Replication lag also becomes a real operational concern (monitoring, alerting, a bound beyond which the replica is not used).

## Evidence

- Spike: `Rota-evidence/read-routing/spike-replicas.ts` and its output (summarised above). Replica check: both replicas answer `pg_is_in_recovery() = true`,
  on the right project, with the same rows as the primary.
- `server/src/db/readRouting.unit.test.ts` (17): data.md tests 4, 5, 6, 7 and 10, the fallback on a connection error, **a query error on the replica is not
  retried on the primary**, the error classifier on the shapes Prisma 7 really produces, the middleware marking before the response.
- `server/src/db/readRouting.integration.test.ts` (6): real replicas, `pg_is_in_recovery()` true for opted-in reads on both shards, false on the primary
  clients; the same user on the primary for 5 s after a write and on the replica at 6 s, with real clocks; raw and model reads on the same client;
  fallback to the primary with an unreachable replica; and a real query error on the real replica (missing table) that is **not** retried: the replica
  ran once, on the replica, with no second attempt on the primary; the route stayed `none`; nothing was reported as a reachability failure.
- `server/src/db/readRouting.http.integration.test.ts`: the three real endpoints over HTTP, with the replica's own query log and the request log's `dbRoute`.
- Lag: `Rota-evidence/read-routing/lag-measurement.txt`.
