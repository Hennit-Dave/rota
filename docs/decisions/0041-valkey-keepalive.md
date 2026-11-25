# 0041: Keep every long-lived Valkey connection busy

- **Status:** accepted
- **Date:** 2026-11-25
- **Decided by:** Dave
- **Related:** issue #79, issue #87 (the timed sweep, not done); ADR 0040 (incident); ADR 0004 (the reconnect trigger);
  ADR 0018 (half-open recovery, issue #39); ADR 0003 (the 15-second interval); `jobs.md`

## Problem

Aiven closes a Valkey client connection that has sent nothing for `valkey_timeout` seconds: 300 on our instance, measured. Most of
Rota's Valkey connections are idle most of the time. ioredis reopens a closed connection at once, so nothing fails outright, but every
reopening is a `close` then a `ready`. On the worker's sweep connection, each one started a full reconciliation pass on both shards
(ADR 0004's reconnect trigger). That was a Postgres query every 5 minutes, the same length as Neon's fixed Free-plan suspend delay. So
neither primary ever scaled to zero, and shard A's 100 CU-hour allowance ran out on 20 November 2026 (ADR 0040, incident). On the API,
the same idle close leaves a short window where the rate limiter answers 503, or an enqueue fails and its row waits for the sweep.

## Options considered

1. **A `PING` every 15 seconds on every long-lived producer connection, built into `createProducerConnection`.** Valkey only. It
   reuses the 15 s already approved for the stalled check (ADR 0003) and already used by the consumer watchdog (ADR 0018), so there is
   no new number. It also beats any NAT idle timeout on the path. A `PING` with no reply is the same half-open signal as issue #39, so
   it can trigger the existing recovery. Cost: 4 tiny commands a minute per connection, on 5 connections. Aiven Free-1 is a dedicated
   node, not metered by command (ADR 0003).
2. **TCP keepalive (ioredis `keepAlive`).** Ruled out. Valkey's idle timer is reset by commands, and TCP keepalive probes never reach
   Valkey as commands, so Aiven would still close the connection.
3. **Set Aiven's `valkey_timeout` to 0.** Not chosen. Aiven's page does not say that 0 turns the timeout off, or whether Free may
   change it. The setting would live outside the repo, and it would not cover a NAT on the path. It could still be added later on top
   of option 1.
4. **Drop the reconnect trigger, or rate-limit it.** Ruled out. It is what restores work seconds after a real Valkey outage (`jobs.md`,
   Recovery triggers). The trigger is right; the reconnects were wrong.
5. **A keep-alive on the sweep's connection only.** That alone fixes Neon. Not chosen. "Aiven closes idle clients, so every connection
   we hold stays busy" is one rule, easier to review than a hand-picked list, and it also closes the API's 503 and enqueue window.

## Decision

Option 1. `createProducerConnection` starts a keep-alive on every connection it makes. Every `VALKEY_KEEPALIVE_MS` (equal to
`BULLMQ_STALLED_INTERVAL_MS`, 15 s) it sends `PING` over a connection that is `ready`. A `PING` with no reply on a `ready` connection
goes to `recycleIfStale` (ADR 0018), which replaces the connection. A connection that is not `ready` is left alone, and a lazy one
nobody opened is never opened by this. The keep-alive stops when the connection ends for good.

Covered: the API's rate limiter, team cache and queue producer; the worker's sweep connection (which also carries the worker's own
enqueues) and team cache. The consumer's connection (`createWorkerConnection`) is unchanged: its watchdog already sends `PING` every
15 s, which is why it never cycled.

## Why

- **Measured:** an idle connection from Dave's machine to our Aiven instance was closed after 300.0 s (25 November 2026). Aiven's
  docs list `valkey_timeout` with a default of 300. Issue #79 shows the deployed worker's reconnect passes 5 minutes apart. Two
  network paths, the same 300 s: it is the server's timeout, not a NAT.
- **Reproduced locally:** a disposable `valkey-server` was started with `--timeout 1`. Before the fix, an idle producer connection
  was closed twice in 4 s, and the reconciler ran `startup, reconnect, reconnect`. After the fix: 0 closes, and `startup` only. The
  test did not change between the two runs.

## Consequences

- **Idle hours stay idle for Neon, except the 30-minute timed sweep.** That costs about 30 CU-hours a month per project (`jobs.md`).
  Making it skip when nothing is due is issue #87, not done. That issue holds the per-day estimates.
- **Recovery after a silent queue loss is no longer accidentally fast.** PR #77's queue-loss proof was restored by a
  reconnect-triggered pass, which in hindsight was this idle close, not a genuine Valkey blip. The proof still shows that the sweep
  restores a lost job from Postgres. With this fix, the same case waits for the timed sweep: up to about 32 minutes (`jobs.md`'s
  delay table).
- **`VALKEY_KEEPALIVE_MS` must stay below Aiven's `valkey_timeout`.** It follows `BULLMQ_STALLED_INTERVAL_MS`, which can be set from
  the environment. Setting that to 300 s or more would bring the bug back.
- **A half-open idle connection is now found by the keep-alive,** not only by the next request that fails on it. It is logged as
  `[valkey:keepalive_recycled]`.
- **One test needed a change.** The issue #39 test that shows the old behaviour ("without the recovery … stays dead") now pushes the
  keep-alive out of its window, because the keep-alive is a second recovery path.
- **Revisit if:** Aiven's timeout changes, the Valkey provider starts metering commands, or a long-lived connection is added that does
  not come from `createProducerConnection`.

## Evidence

- `server/src/jobs/valkey-keepalive.integration.test.ts` (3 tests, disposable local Valkey, no Postgres): red before the fix, green
  after, with the test unchanged. Logs are in the PR.
- `server/src/jobs/connection.unit.test.ts`: 5 keep-alive tests (one `PING` per interval; nothing on a connection that is not ready,
  and nothing opened; a `PING` with no reply replaces the connection once; an error reply changes nothing; stops on `end`).
- `server/src/api/app.unit.test.ts`: `GET /health` answers from an app with no database and no Valkey.
- **Pending, after the Neon reset (about 1 December 2026):** deploy, resume both services (CI/CD back on), and a Neon monitoring
  screenshot showing the primary suspends after 5 idle minutes.
