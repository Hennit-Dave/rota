# 0006: Password hashing (Argon2id) and the library

- **Status:** proposed (accepted when Dave merges PR A)
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** PR A (`feat/auth-server`), `.agents/rules/security.md`, ADR 0005, issue #14 (containerise `server/`)

## Problem

Passwords must be stored so that a stolen database does not give up the passwords. `security.md` says Argon2id,
starting at OWASP's minimum (19 MiB memory, 2 iterations, parallelism 1), benchmarked on the chosen host and
recorded here. A library has to be chosen, and it will be a native addon.

## Options considered

1. **`argon2` 0.45.1** (node-argon2): works, but its `install` script (`node-gyp-build`) is blocked by npm 12's
   default, so every install prints a warning and the package relies on prebuilt binaries found at load time. It also
   pulls in four packages (`cross-env`, `@phc/format`, `node-addon-api`, `node-gyp-build`).
2. **`@node-rs/argon2` 2.2.2:** no install script and no dependencies. It ships one prebuilt binary per platform as
   `optionalDependencies`, so `npm` installs exactly the one that matches the machine. MIT.
3. **Hand-rolled with `node:crypto`:** Node has `scrypt` built in but not Argon2id. Rejected: `security.md` names Argon2id.

## Decision

- **`@node-rs/argon2` 2.2.2**, pinned exactly. Both options 1 and 2 were installed in a throwaway folder and tested on
  2026-10-21: both hash and verify correctly; option 2 needs no blocked scripts.
- **Argon2id, 19456 KiB (19 MiB), 2 iterations, parallelism 1.** The library writes the parameters and a unique random
  salt into the hash (`$argon2id$v=19$m=19456,t=2,p=1$…`), so raising the numbers later still verifies every older hash.
- **Timing.** An unknown email is verified against a dummy hash made at startup with the same settings, so a login for
  a missing account costs the same single Argon2 run as one for a real account (`security.md`). A test counts the
  verifications to prove it.
- **Passwords are NFC-normalised before hashing and counted in Unicode code points** (ADR 0005).
- **Hashes never leave the server:** not in responses, logs, Sentry or job payloads.

**Benchmark (local only, not the deployment host).** 2026-10-21, Apple M3 Pro, arm64, 12 cores, Node 24.16.0, through
the repo's own `argon2Hasher`, 30 runs after one warm-up:

| | min | median | p95 | max |
|---|---|---|---|---|
| hash | 6.7 ms | 6.9 ms | 8.8 ms | 8.8 ms |
| verify | 6.6 ms | 6.7 ms | 7.0 ms | 7.1 ms |

These say nothing about the free host, which has a fraction of a vCPU. **Re-benchmark on the deployed host and add the
numbers here** (`security.md`). If a verify there is far slower, login throughput, not security, is what changes.

## Why

- No blocked install script and no dependency chain: fewer moving parts in a security-critical path.
- A native addon is a server-side concern only: it does not touch the app or an EAS build.

## Consequences

- **For the Docker image (issue #14): the image's platform must be one `@node-rs/argon2` ships a prebuilt binary for.**
  Verified in the registry for 2.2.2 and present in `package-lock.json`: `linux-x64-gnu`, `linux-x64-musl`,
  `linux-arm64-gnu`, `linux-arm64-musl`, `linux-arm-gnueabihf`, `darwin-x64`, `darwin-arm64`, `freebsd-x64`,
  `android-arm64`, `android-arm-eabi` and three Windows targets. So a Debian/Ubuntu (glibc) or Alpine (musl) image on
  x64 or arm64 works. Anything else (for example RISC-V or s390x) does not. **Install with `npm ci` and never
  `--omit=optional`**, or the platform binary is not installed and the API fails when it first hashes. Also run one
  hash during the image build or health step so a missing binary fails the build, not the first user.
- The `Algorithm` enum in this library is an ambient const enum, which this project's `verbatimModuleSyntax` forbids
  importing. The code passes Argon2id as its numeric value `2` and a unit test asserts every hash really is Argon2id
  with the stated parameters, so a change in the library's numbering would fail loudly.
- **Not built yet:** rehashing on login when the parameters change. Verification already reads the parameters from
  each hash, so it can be added without a migration.
- **Revisit when:** the host is chosen (re-benchmark), or OWASP changes its minimum.

## Evidence

`server/src/auth/password.unit.test.ts`: hash format and parameters, correct and wrong passwords, two hashes of one
password differ, a malformed stored hash fails safely, NFC and code-point counting, and exactly one verification per
login attempt whether or not the account exists. `login.integration.test.ts` proves the same through the route.
