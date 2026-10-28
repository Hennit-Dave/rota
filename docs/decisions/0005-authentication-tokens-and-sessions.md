# 0005: Authentication tokens, sessions and the password policy

- **Status:** accepted (2026-10-21; Dave approved every decision in it)
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** PR A (`feat/auth-server`), `.agents/rules/security.md`, ADR 0006 (password hashing), ADR 0007 (rate limiting)

## Problem

Rota needs email and password sign-up and login, short-lived access tokens, refresh tokens that rotate on every
use with reuse detected, and "log out of all devices" (brief, Requirement 3). `security.md` fixes the shape but
leaves every number to an ADR: token lifetimes, the clock-skew allowance, the password policy. This records them.

## Options considered

1. **Where session state lives.**
   - *Stateless JWT only:* nothing to look up, but a logout or a detected theft cannot stop an access token
     before it expires.
   - *Opaque tokens only:* every request is a database lookup, but revocation is immediate.
   - *JWT plus a session check on shard A's primary:* a signed token that carries the session (family) ID, and
     one primary read per request. Revocation is immediate; the token still names the session. **Chosen**
     (`security.md`). The cost is one extra primary read per authenticated request, which the k6 report must show.
2. **Public error codes for failed sessions.** One code per cause (expired, reused, revoked) helps debugging
   and tells an attacker holding a stolen token that it was caught. One code for all of them tells nobody anything.
3. **Duplicate email at sign-up.** Return 409 (reveals that the address has an account), or pretend success
   (impossible without a verification email to send, which is deferred).
4. **Password minimum length:** 8 (the Figma helper text, the OWASP ASVS 5.0 Level 1 floor) or 15 (NIST).

## Decision

**Lifetimes (approved 2026-10-21; no source gives these numbers, they are a trade-off):**

| Setting | Value | Reason |
|---|---|---|
| Access token | 15 minutes | Bounds a token stolen *before* anyone notices; once the session is revoked the per-request check stops it at once, so the lifetime matters less than it would for a stateless token. |
| Refresh token idle expiry | 30 days | How long a phone can sit unused before a fresh login. |
| Token family absolute lifetime | 90 days | Caps a stolen-then-kept-alive refresh chain. |
| Clock-skew allowance | 0 seconds | The same process issues and verifies; there is no second host to disagree with. Revisit if a second verifier ever exists. |

**Tokens and sessions:**
- Access token: JWT, HS256 only, claims `sub`, `sid` (family ID), `iat`, `exp`, `iss` (`rota-api`), `aud` (`rota-app`).
  No role and no team. Verification rejects any other `alg`, including `none`.
- Signing key: `AUTH_JWT_SECRET`, base64 of at least 32 random bytes. RFC 7518 section 3.2 requires an HS256 key at
  least as large as the hash output (256 bits). The server refuses to start without it.
- Refresh token: 32 random bytes (256 bits), base64url, opaque. Only its SHA-256 is stored. SHA-256 is fine here
  because the token is high-entropy random data; a password would need a slow hash.
- A *family* (one per device login) is the session. Revoking the family revokes every token in it, so there is no
  per-token revocation column: one source of truth.
- Rotation, reuse detection and revocation follow `security.md` exactly: one transaction, the family row locked
  `FOR UPDATE`, reuse revokes the family and **commits** before the 401 is returned. **No grace window.**
  - `POST /auth/refresh` takes `{ refreshToken }` (exactly 43 base64url characters, else `400`), is rate limited by IP
    (`refresh_ip`) *before* the database is touched, and answers `200 { session }`. The presented token is looked up by hash
    outside the transaction (so a made-up token costs one read), then inside it: lock the family, reject if revoked or past
    its absolute expiry, consume the token with one conditional `UPDATE` (unused and not idle-expired), insert the
    replacement, commit. The replacement's idle expiry is capped at the family's absolute expiry.
  - The transaction **returns** its outcome and the route throws the 401 afterwards. Throwing inside would roll back the
    family revocation and leave a stolen session alive.
  - Only a token that was already **used** counts as theft. An idle-expired token, an expired family or an already revoked
    family is refused (401) without revoking anything further, and an earlier `revoked_reason` is never overwritten.
  - `POST /auth/logout` (this device) and `POST /auth/logout-all` (every device) are user routes (access token and session
    check, empty body and query). They take the same family lock. `logout-all` locks all of the user's families **in id order**
    so two of them, or one of them against a single-family lock, cannot deadlock. Both answer `204` and are idempotent.
  - `revoked_reason` values: `logout`, `logout_all`, `reuse_detected`.
- **Transaction wait.** Every auth transaction waits up to **5 s** to start (`AUTH_TRANSACTION_MAX_WAIT_MS`, default 5000;
  Prisma's own default is 2 s). **Measured locally; re-measure on the deployment host.** Basis: a first query on a cold
  connection to Neon took 3.7 s from the development machine, so 5 s is that plus margin. If it still cannot start in time
  (Prisma `P2028`), the answer is `503 service_unavailable`, not `500`; nothing was consumed, so the app can retry. The re-measure
  is tracked on issue #7.
- **App rule for refresh failures (for the app slice).** Any `400` or `401` from `POST /auth/refresh` means **sign out locally**
  (clear the secure-store tokens and the caches). A `400` also means the app sent a malformed token, which is an app bug: log it.
  A `503` or a network error is **not** a sign-out: keep the tokens and retry. Logout (`/auth/logout`, `/auth/logout-all`) returns
  `204` with an empty body.
- **One public 401 code, `unauthenticated`,** for every failed access token or refresh token. The true reason
  (`reuse_detected`, `expired`, `revoked`, `unknown`) goes to the server log only.
- Errors share one body: `{ error: { code, message, requestId, details? } }`. The app switches on `code`.

**Password policy** (the number the Figma design shows, 8, is changed to 15; Dave updates the design):
- Minimum **15**, maximum **128**, **no composition rules**.
- Source, read from the NIST page itself on 2026-10-21 (https://pages.nist.gov/800-63-4/sp800-63b/authenticators/,
  SP 800-63B-4, section 3.1.1.2 "Password Verifiers"). The fetched text did not show the document's version or
  date, and was cut off after section 3.1.1; the quotes below are verbatim from the part that was read:
  - Minimum, single factor: *"Verifiers and CSPs **SHALL** require passwords that are used as a single-factor
    authentication mechanism to be a minimum of 15 characters in length."* Rota is password-only, so this applies.
  - Minimum, multi-factor (does not apply): *"Verifiers and CSPs **MAY** allow passwords that are only used as part
    of multi-factor authentication processes to be shorter but **SHALL** require them to be a minimum of eight
    characters in length."*
  - Maximum: *"Verifiers and CSPs **SHOULD** permit a maximum password length of at least 64 characters."* Our cap of
    128 is above that and exists only to bound request size.
  - Composition: *"Verifiers and CSPs **SHALL NOT** impose other composition rules (e.g., requiring mixtures of
    different character types) for passwords."*
  - Counting: *"Each Unicode code point **SHALL** be counted as a single character when evaluating password length."*
    Length is therefore counted in code points, not UTF-16 units (an emoji is one character, not two).
  - Truncation: *"Verifiers **SHALL** request the password to be provided in full (not a subset of it) and **SHALL**
    verify the entire submitted password (e.g., not truncate it)."* Over-long passwords are rejected, never cut.
- **Implemented in PR A stage 2:** passwords are NFC-normalised (a SHOULD in 3.1.1.2), length is counted in code points,
  over-long passwords are rejected rather than cut, and a blocklist check exists (its list is empty, see Consequences). A password that fails any of these is
  `400 validation_failed` with a detail on path `password`: code `too_short` (with `min`), `too_long` (with `max`) or
  `password_common`. Login applies none of these rules (a short old password is checked, not rejected).
- OWASP ASVS 5.0 requirement 6.2.1 sets 8 as its Level 1 floor and "strongly recommends" 15
  (https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md; read through a search excerpt only).

**Duplicate email at sign-up:** `409 email_in_use`. This reveals that an address has an account. It is an
**accepted trade-off**: sign-up verification email is deferred, so there is no way to answer identically, and
the route is rate limited (ADR 0007). **Squatting risk until magic link / verification lands:** anyone can register
someone else's address (unverified, `security.md` account-verification policy) and hold the account; the real owner
cannot register and must recover through magic link or reset, which arrive in the password reset and magic link slice.

## Why

- Revocation has to be immediate for "log out of all devices" and for reuse detection to mean anything.
- A single public 401 code gives an attacker holding a stolen token no signal about whether the theft was caught.
- 15 characters follows the standard that applies to password-only accounts.

## Consequences

- **Easier:** logout, logout-all and theft response take effect on the very next request.
- **Harder:** one primary read per authenticated request (measured later by k6).
- **Known weaknesses, accepted:**
  - No grace window: a refresh whose response is lost looks like reuse on the next refresh and forces a login.
  - Used refresh-token rows must be kept until their family expires so reuse can be detected. They accumulate; a
    purge job is a follow-up (issue #20), not in PR A.
  - A login that starts while `logout-all` runs creates a new family and is not revoked by it.
  - A thief who refreshes *first* and keeps rotating while the real owner is offline holds a working session (up to the
    90-day absolute limit) until the owner's next refresh presents the old token. That is detected and kills the family, but
    until then there is no signal. Reuse detection catches theft only when both parties use the token.
  - A refresh that can't start its transaction within the 5 s wait (cold database connection) is a retryable `503`. The 5 s was
    measured on the development machine only (see Decision).
  - Used and expired refresh-token rows are never deleted yet; a purge job is a separate follow-up, tracked in issue #20.
- **NIST SHALL not yet met: no list with a confirmed data licence.** Decided by Dave on 2026-10-21: option C, defer and
  document the gap; **no list is bundled.** NIST 3.1.1.2: *"verifiers **SHALL** compare the prospective secret against a
  blocklist that contains known commonly used, expected, or compromised passwords. The entire password **SHALL** be subject
  to comparison, not substrings or words that might be contained therein."* The mechanism is built and tested (whole
  password, NFC, case-insensitive, error `password_common`; `server/src/auth/blocklist.ts`), but the production list is
  **empty** and the API logs `password_blocklist_empty` at every startup, so the gap cannot go unnoticed.
  - *Why deferred.* The best candidate was SecLists (`Passwords/Common-Credentials/xato-net-10-million-passwords*.txt`),
    whose repository licence is MIT (Copyright (c) 2018 Daniel Miessler). Nothing in that repository says the MIT grant
    covers the password data itself or states the licence of the upstream dataset. The UK NCSC top-100k list could not be
    checked (its page is removed and its file and terms pages return 404). A confident "clean licence" was not possible.
  - *What a list would cost, measured:* only entries of 15 or more characters matter, because shorter passwords are already
    rejected by length. From SecLists, 10,908 entries (188 KiB) come from the top 1M, and 141,033 entries (2.4 MiB) from all 5.2M.
  - *To close the gap:* confirm the data licence of one list (or write our own), bundle it with its source, licence notice and
    a generator script, and replace this bullet. Tracked in `AGENTS.md` under "Later proofs (not blocking)".
- Also from NIST 3.1.1.2, handled: NFC normalisation, counting code points, no truncation, no composition rules. Not
  handled: *"Verifiers **SHALL** allow the use of password managers and autofill functionality"* is a property of the app's
  inputs, to be checked in the app slice.
- **Revisit when:** the host is chosen (re-benchmark hashing, ADR 0006; measure cold-connection time and set the transaction wait), a second API process exists (clock skew),
  or sign-up verification email is built (the 409 trade-off and the squatting risk).

## Evidence

Run from `server/`; integration tests need the `TEST_*` variables in `.env` and use the test shards.

| Behaviour | Test (file) |
|---|---|
| Rotation: new token, old token refused, hashes only in the database (security.md 5) | `refresh.integration.test.ts` |
| Reuse revokes and commits the family; newest token and its access tokens die; another device lives (6) | `refresh.integration.test.ts` |
| Two simultaneous refreshes: one 200, one 401, the winner's new token dead (7); three at once: one winner (data.md 9) | `concurrency.slow.test.ts` |
| Revocation race, deterministic: revocation first, and refresh first (8) | `concurrency.slow.test.ts` |
| Revocation race, repeated 15 times with random offsets: nothing survives (8) | `concurrency.slow.test.ts` |
| Logout ends this device only; logout-all ends every family, keeps earlier reasons, spares other users (9) | `logout.integration.test.ts` |
| No deadlock when logout, logout-all and refresh run together | `concurrency.slow.test.ts` |
| Same 401 body for unknown, idle-expired, expired and revoked; reason only in the log | `refresh.integration.test.ts` |
| 429 before the token is touched; Valkey down is 503 and consumes nothing; no token in any log line | `refresh.integration.test.ts` |
| Token shape, strict body | `schemas.unit.test.ts`, `refresh.integration.test.ts` |
| P2028 and a dropped connection are a 503 | `http.unit.test.ts` |

Commands and the live request/response sequence are in the PR A description.
