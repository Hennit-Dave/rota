# 0018: Recovering from a half-open Valkey connection

- **Status:** proposed (accepted when Dave merges). Part 1 (the API's clients) and part 2 (the worker's consumer, approved by Dave 2026-10-26 with two conditions) are both decided here.
- **Date:** 2026-10-26
- **Decided by:** Dave
- **Related:** issue #39, `.agents/rules/jobs.md`, `.agents/rules/security.md`, ADR 0003 (connection policies), ADR 0004 (reconciliation sweep), ADR 0007 (rate limiting)

## Problem

After the developer's Mac slept overnight, every rate-limited route of the local API answered `503 service_unavailable` until the API process was restarted (`rate_limiter_unavailable: Command timed out` on each request). A fresh connection to the same Valkey answered at once, so Valkey was fine: the API's long-lived connection was dead and never recovered. On a deployed server the same thing would take login, sign-up, refresh and invites down until someone restarted the process.

## What actually happens (reproduced)

In plain words: the API keeps one connection open to Valkey and reuses it. If that connection dies **quietly** (no "goodbye" reaches us), the API cannot tell. Each request sends a command and waits for an answer that never comes, our 2-second command timeout fires, and the limiter fails closed with a 503. The connection still calls itself `ready`, so nothing ever reconnects.

Reproduced on a local Valkey 9.1.2 behind a small TCP proxy that can cut the connection two ways, using the repo's own `createProducerConnection` and limiter, and then the real API process:

| Outage | Result before the fix |
|---|---|
| **Clean drop** (sockets destroyed, or the Valkey process stopped and started) | ioredis sees the connection close and reconnects by itself. The next request works. |
| **Half-open** (the proxy keeps the socket open and silently drops the traffic, like a laptop waking up behind a NAT that forgot the mapping) | Every request fails with `Command timed out` for as long as the process lives, **even after the network is back**. `status` stays `ready`, no `close` or `error` event fires. A fresh connection at the same moment answers in 1 ms. |

The same API process (pid 62491) was still returning 503 about 20 seconds after the network returned (six probes). The worker's consumer has the same problem (see part 2): after the network returned, a job queued during the outage and a job queued afterwards were both still unconsumed 45 seconds later.

**A second silent state, found while building the worker fix.** ioredis 5.11.1 sends `CLIENT SETINFO` when a connection opens and only then marks it `ready` (`redis/event_handler.js`). A connection opened while the path still swallows traffic (TCP accepted, no replies) therefore stays in status `connect`. The producer connections have a command timeout, so those handshake commands time out and the connection reaches `ready` (dead), and the normal recycle then catches it. The worker's connection has no command timeout (BullMQ needs `maxRetriesPerRequest: null`), so it stays in `connect` for ever. The worker rule below covers it.

**What is and is not known about the cause.** Aiven's own documentation for the Free plan ([free tier](https://aiven.io/docs/products/valkey/concepts/valkey-free-tier), [free plan](https://aiven.io/docs/platform/concepts/free-plan)) says it may power off free services with "no continuative activity" and sends a notification first. It gives no idle period and says nothing about idle-connection timeouts, keepalive or connection limits. A power-off is a clean drop (the server goes away and its sockets are closed), which already heals. So the documentation does **not** show that Aiven drops idle connections silently, and the evidence does not show which network element (the Mac's Wi-Fi after sleep, a NAT, Aiven) dropped it in the real incident. The fix does not depend on knowing: it handles any silent drop. Separately, ioredis 5.11.1 defaults `keepAlive` to `0`, which turns TCP keepalive on with the operating system's default timing; I believe that is hours, but I did not verify it, so nothing here relies on it.

## Options considered

1. **A short TCP keepalive.** Node only sets the delay before the first probe; the probe interval and count belong to the operating system, so detection stays slow and differs by platform. It also needs a new number. Not enough alone.
2. **A heartbeat `PING` every N seconds.** Detects a dead connection early, but needs a new number N, and on a free instance it is constant "activity" that Aiven's inactivity rule would no longer see as idle (not our call to make).
3. **Replace the connection when a command times out on a connection that still says `ready`.** The evidence of a dead socket is exactly that: no answer, no close. It reuses the 2-second command timeout already approved (ADR 0003) and ioredis's own defaults. **No new setting.**

## Decision

**Part 1, the API's clients: option 3.** `recycleIfStale` (`server/src/jobs/connection.ts`) calls `disconnect(true)` on a connection that is `ready` when a command timed out (ioredis's `Command timed out`, or our own enqueue timeout). ioredis closes the socket, destroys it after its own `disconnectTimeout` if the close never completes (that default is 2000 ms in `RedisOptions.js`; we do not set it), and reconnects with its default retry strategy. Wired for every client the API and the worker's sweep use:

- the **rate limiter** (`onUnavailable` hook in `limiter.ts`, wired in `api/main.ts`);
- the **queue producer** in the API and the **reconciliation sweep's** queue (`addWorkJob` and the sweep's job lookup call `recycleQueueConnection`, which finds the connection each queue was built with).

Unchanged: the failing request still fails (503, fail closed); `noeviction` is never touched; an error *reply* (OOM under `noeviction`) is not a timeout and never recycles. A burst of timeouts starts one replacement, not one per request.

**Part 2, the worker's consumer: a watchdog** (`server/src/jobs/consumer.ts`, wired in `worker/main.ts`). BullMQ waits on a blocking command (`BZPOPMIN`), which a half-open connection never answers, so the consumer neither fails nor reconnects. A command timeout on the consumer cannot fix it: the wait lasts the drain delay (5 s by default) or until the next delayed job is due, so no fixed timeout is safe.

- Every `BULLMQ_STALLED_INTERVAL_MS` (15 s, already approved in ADR 0003) a `PING` goes over the worker's own connection, limited to `PRODUCER_COMMAND_TIMEOUT_MS` (2 s, ADR 0003). **No new number.**
- Silence while ioredis still says `ready` rebuilds the whole consumer in place: a new connection and a new worker (so BullMQ's duplicated blocking connection is replaced too), handlers re-attached. The old worker is closed with `close(true)`, bounded by the same 2 s, and its connection is then disconnected hard.
- A connection that is not `ready` is left to ioredis (it is already reconnecting). A `PING` answered with an error is not silence and rebuilds nothing.
- **The handshake rule:** the same connection found in `connect` on two probes in a row (a full interval apart) is treated as silence too (see the second silent state above). A normal handshake takes milliseconds. The two-probe rule is not a new setting: it reuses the interval.
- **Guard (Dave's condition 1): a rebuild never starts while another is in progress.** One flag covers the probe, the build and the bounded teardown of the old consumer, set with no `await` between the check and the set; a tick that finds it set does nothing, and probes never overlap.
- A job running at the moment of a rebuild is recovered by BullMQ's stalled-job check and our claim lease (`jobs.md`); an email is protected by its idempotency key `email-<rowId>`.

**Known limit (Dave's request): only the blocking connection dies.** BullMQ duplicates the worker's connection for its blocking commands. The probe runs on the worker's own (non-blocking) connection. If **only the blocking connection** went silent while the other stayed alive, the `PING` would be answered and nothing would be rebuilt, and the worker would stay idle until restarted. The realistic cases (a laptop sleeping, a NAT forgetting the mapping, a vanished peer) cut the whole path, so both connections die together, and that is what the tests cut. This limit is not tested and not fixed. What would fix it: probing BullMQ's blocking connection too, which BullMQ 6 does not expose. The Postgres reconciliation sweep (ADR 0004) still restores any job lost from the queue, so work is delayed, not lost.

## Why

- It follows the evidence: the connection is dead exactly when a command gets no answer while `ready`.
- It adds no setting to invent and no request-path work: nothing changes on a healthy connection.
- The alternatives either need a number nobody can justify from a source (1, 2) or change Aiven-visible behaviour (2).

## Consequences

- **Easier:** a laptop sleep, a NAT change or a silent drop no longer needs a restart. Measured on the local Valkey: the same connection object served requests again 304 ms after the network returned (queue producer: 305 ms); the real API went from 503 to 401 with the same pid.
- **Still true:** the one request that hits the dead connection waits the 2-second command timeout and answers 503. The limited routes answer 503 for as long as Valkey is genuinely unreachable. Worst case from the first failing request to a working connection is about the command timeout plus ioredis's `disconnectTimeout` (2 s + 2 s) plus its first retry delay, once the network is back.
- **Accepted:** a Valkey that is only *slow* (commands exceeding 2 s) causes a reconnect per timed-out burst. Reconnecting is cheap and the limiter was already failing closed for those requests. If the load test shows reconnect churn, revisit with a cooldown (a number, to be justified then).
- **Worker recovery time is longer, and measured.** In the real worker process (local Valkey, whole path cut for about 23 s, same pid), the first rebuild came at the next probe after the cut, but that replacement was opened into the still-dead path and sat in the handshake, so a second rebuild happened one probe interval later and the worker consumed both queued jobs about 19 s after the network returned. The worst case after the network returns is about two probe intervals (30 s) plus the 2 s teardown. While a path stays dead the watchdog rebuilds about every two intervals: cheap, no jobs are touched, and each rebuild is guarded.
- **The sweep is not delayed by the recycle.** The reconciliation sweep's own queue connection recycles on timeout; its existing "after a Valkey reconnect" pass runs when the replacement is ready.
- **Not re-verified on a rebuild:** `noeviction` is checked once at worker start (ADR 0003), not again after a rebuild; the policy is the instance's, not the connection's.
- **Revisit when:** the host is chosen (its proxy may change idle behaviour); Aiven documents an idle-connection timeout; BullMQ exposes its blocking connection (the known limit above); the load test shows reconnect churn.

## Evidence

- `server/src/jobs/valkey-recovery.integration.test.ts` (disposable local Valkey only; the tests refuse to run without `valkey-server` and never read `VALKEY_URL`): half-open recovery on the limiter, the HTTP route (503 then 200, same server), and the enqueue; the same half-open connection **stays dead without the fix** (the bug); a clean drop does not trigger the recycle; a stopped and started Valkey process recovers. Mutation-checked: removing the `disconnect(true)` fails the three half-open tests.
- Worker consumer, same file: **the whole network path cut** (the worker's connection and the blocking connection die together): with the watchdog the same worker consumes the job queued during the outage and the one queued after; without it the same worker consumes neither (the bug). Mutation-checked: removing the rebuild fails it, and so does removing the handshake rule.
- A second producer test: an outage that outlasts the first recycle (the replacement connects into the dead path) still recovers.
- `server/src/jobs/connection.unit.test.ts` (5 tests): only timeouts count, one replacement per burst, nothing when not `ready`. `server/src/jobs/consumer.unit.test.ts` (9 tests): answered probe changes nothing, silence rebuilds once, not-ready and error replies rebuild nothing, **the guard** (three ticks during a rebuild all skip, one rebuild total), a close that never finishes cannot hold the rebuild, the handshake rule and its reset, timer and `stop()`.
- Terminal logs, kept outside the repo and pasted in the pull request: the real API process before (503 for 20 s after the network returned, same pid) and after (recovers, same pid); the worker experiment before; the real worker process after (same pid consumes both jobs). In the API logs the `401` after the fix is the expected answer: the request got past the rate limiter and the login check rejected the test credentials. A `503` would be the failure.
