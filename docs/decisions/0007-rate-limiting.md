# 0007: Rate limiting in Valkey

- **Status:** proposed (accepted when Dave merges PR A)
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** PR A (`feat/auth-server`), `.agents/rules/security.md`, `.agents/rules/caching.md`, ADR 0005, issue #7

## Problem

Login, sign-up and refresh are public routes that anyone can hit. The brief requires rate limits held in Redis (here
Valkey, ADR 0003), never in process memory, per IP and per user. `security.md` fixes the rules and leaves the
mechanism and the thresholds to an ADR.

## Options considered

1. **A rate-limit library.** More features (sliding windows), another dependency, and it must still be given Valkey.
2. **Lua script** for an atomic counter. Atomic, but depends on `EVAL` being allowed on the managed instance.
3. **A pipeline of plain commands:** `SET key 0 EX window NX`, `INCR key`, `PTTL key`. No Lua, no dependency. The
   `SET ... NX EX` creates the key with its TTL in the same step, so a crash mid-way leaves a key that still expires.

## Decision

Option 3, a **fixed window** per rule. `server/src/ratelimit/limiter.ts`.

- **Keys:** `rl:v1:<rule>:<sha256(subject)>`. The subject (an IP, or a normalised email) is hashed so Valkey holds no
  raw email and a hostile subject cannot inject key text. Every key has a TTL from the moment it exists.
- **Order:** Zod, then rate limit, then handler (`security.md`). The limiter runs **before password verification**, so
  a blocked attempt never costs an Argon2 run. It counts *attempts*, not failures, because it must decide before
  it can know the outcome.
- **All rules are counted** even when an earlier one already denied, so counters stay truthful. The response carries
  the longest `Retry-After`.
- **Fail closed:** if Valkey is unreachable or rejects the write (possible under `noeviction`), the route answers
  `503 service_unavailable`. The handler never runs. Logout and logout-all are not on the limited list, so they
  keep working with Valkey down.
- **IP:** the TCP peer address (`req.socket.remoteAddress`), IPv4-mapped IPv6 folded to IPv4. `X-Forwarded-For` is not
  trusted until the host's proxy setup is verified (`security.md`).

**Thresholds** (approved 2026-10-21; no source gives these numbers; config, in `docs/SECURITY.md`):

| Rule | Limit | Window |
|---|---|---|
| `login_ip` | 30 | 15 minutes |
| `login_email` | 5 | 15 minutes |
| `register_ip` | 10 | 1 hour |
| `refresh_ip` | 60 | 15 minutes |

## Why

- The limits are per IP *and* per email, as `security.md` requires: per IP slows one machine trying many accounts, per
  email slows many machines trying one account (credential stuffing).
- 30 per IP, not something tighter, because a restaurant's staff share one wifi address and may all log in at shift start.

## Consequences

- **Known weakness, accepted: lockout.** The per-email limit lets anyone make 5 attempts at a victim's email and block the
  real owner for up to 15 minutes. A window that long is the price of slowing credential stuffing.
- **Known weakness, accepted: fixed-window bursts.** A client can use the limit at the end of one window and again at the
  start of the next, up to twice the limit across the boundary.
- **Behind a shared proxy every client shares one address,** so the per-IP rules would throttle everyone together. This must
  be revisited when the host is chosen (issue #7: behind Northflank's proxy).
- Memory: each key is small and expires; the keys share Valkey with the queue under `noeviction`, so a full instance
  makes limiting (and the routes) fail closed rather than silently stop limiting.
- **Revisit when:** the proxy setup is verified, or the load test shows the thresholds need to move.

## Evidence

`server/src/ratelimit/limiter.integration.test.ts` (real Valkey, unique prefix, exact-key cleanup): counting and
denial, a TTL on every key, 25 simultaneous attempts counted atomically, window reset, and Valkey unreachable returns
503 with the handler never run. Route-level 429 and the "no Argon2 run when blocked" check arrive with the login route.
