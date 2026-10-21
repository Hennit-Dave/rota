# 0005: Authentication tokens, sessions and the password policy

- **Status:** proposed (accepted when Dave merges PR A)
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
cannot register and must recover through magic link or reset, which arrive in PR B.

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
    purge job is a follow-up, not in PR A.
  - A login that starts while `logout-all` runs creates a new family and is not revoked by it.
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
- **Revisit when:** the host is chosen (re-benchmark hashing, ADR 0006), a second API process exists (clock skew),
  or sign-up verification email is built (the 409 trade-off and the squatting risk).

## Evidence

Pending PR A stages 2 and 3: the refresh, reuse, concurrent-refresh, revocation-race and logout-all tests, and the
request/response sequence in the PR description.
