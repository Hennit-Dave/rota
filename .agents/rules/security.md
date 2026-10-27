---
trigger: model_decision
description: "Read before writing or changing authentication, passwords, login, signup, password reset, access or refresh tokens, sessions, logout, invites, roles and permissions, team isolation, request validation with Zod, rate limiting, secrets, environment variables, logging of sensitive data, or SECURITY.md."
---

# Security and authorisation

If a rule here conflicts with `AGENTS.md`, stop and ask. The tests at the end are the acceptance criteria.
Auth tables live on shard A; security-sensitive reads always use the primary (`data.md`).

## Request pipelines, by route type

| Route type | Examples | Checks, in order |
|---|---|---|
| Public auth | signup, login, magic-link request and redeem, refresh, reset request, reset submit, invite preview | Zod → rate limit → handler |
| Invite accept | joining a team | Zod → rate limit → **authenticated identity** (existing account's access token + session check, or an account created in the same onboarding flow) → redeem |
| User | settings, push-token registration, log out | Zod → access token → session check → applicable rate limits → owns the resource |
| Team | shifts, swaps, feed, members, billing | Zod → access token → session check → per-user rate limits → membership and role from the team shard primary → **limits keyed by the team or the whole app** (invites, ADR 0015) → handler, every query filtered by `team_id` |
| Stripe webhook | `/webhooks/stripe` | Raw body → signature verified **before any parsing** → Zod on the event → record → acknowledge (`AGENTS.md` rule 7, `money.md`) |

- For normal team routes, resolve the team from the validated route parameter and verify membership. For
  invitation redemption, derive the team and granted role from the validated invitation record. Never from
  the body or the token.
- **A client-supplied user ID is never proof of identity.** Identity comes only from a verified access
  token and its session, or from an account the server creates during onboarding.
- **Another team's resource → 404**, so its existence isn't revealed. **Your team, insufficient role → 403.**
- Roles are loaded from the database on each request, never from the token. *Why: a demotion must take
  effect immediately.*
- **A limit keyed by the team, or by the whole app, runs after the membership and role check** (ADR 0015),
  not before it as the table above lists for per-user limits. *Why: a limit keyed by a team the caller has
  not proven to belong to lets any signed-in user burn another team's daily budget, or the app-wide cap, by
  calling that team's URL.* Per-user limits still run first. A request refused for role or membership never
  counts toward a team or app-wide limit.
- One permission table, in one server module and in `SECURITY.md`. At minimum: Owner alone manages
  billing; Owner and Manager edit shifts and approve swaps; Staff view shifts, request swaps, edit own
  preferences.

## Passwords

- **Argon2id** before storing in shard A's credentials table; the library adds a unique random salt.
  Verify with the library's verify function, never string comparison.
- Start at OWASP's minimum: **19 MiB memory, 2 iterations, parallelism 1**. Benchmark on the chosen host
  and record the settings and timings in an ADR.
- Never plaintext, reversible encryption or plain SHA-256. Passwords and hashes never appear in logs,
  API responses, Sentry events or job payloads.
- Resets use the same policy. Passwords travel only over HTTPS; the app never persists them.

## Login

- One generic failure for "no such user" and "wrong password"; unknown emails still verify against a
  dummy hash, so timing doesn't reveal accounts.
- **Rate limiting runs before password verification**, so a blocked attempt never costs an Argon2 run.

## Magic link (the brief's second sign-in method; chosen over Google)

- Request: the same response whether or not the email has an account. Only existing accounts get an
  email, sent from a job through Resend.
- The token is random, short-lived (config, minutes), stored only as a hash on shard A, and single-use.
- **Explicit redemption:** the link opens an app screen; only the app's `POST` with the token redeems it,
  atomically. Opening the link (or an email scanner fetching it) consumes nothing.
- Request and redemption are rate limited.
- A successful redemption verifies the address under the account-verification policy below.

## Account verification policy (magic link and email-bound invites alike)

Redeeming a magic link or an email-bound invite proves control of the address. When that happens:
- If the matching account's email was **unverified**, one transaction on shard A marks it verified,
  **clears its existing password and revokes all its sessions**, then issues the new session. Whoever set
  that password may not own the address. Never trust an unverified account because its email matches.
- If it was already verified, nothing is cleared.
- **Exception: accepting an invite (ADR 0015).** Acceptance already requires a signed-in session of the
  account whose address matches the invitation, so there is nobody to evict. It marks the address verified
  and does **nothing else**: it never clears the password and never revokes a session. *Why: signup
  verification is deferred, so every account is unverified; clearing on every acceptance would wipe the
  accepter's own password.* **Accepted gap:** an address someone else pre-registered (unverified) blocks the
  real person from creating an account with it. The invite can only be accepted by the account that holds
  the address, so only password reset or magic link (slice 2b) can take such an account over. Until 2b
  exists that person has no way in. The clearing rule above still applies to magic link and reset.
- **Invite ordering across shards:** (1) validate the invite on the team's shard without consuming it;
  (2) on shard A, mark the address verified (no clearing for an invite, see above) and write the
  `user_teams` directory row **first** (ADR 0013); (3) on the team's shard, consume the invite, claim the
  seat (when billing exists) and create the membership in one transaction. Team access exists only after
  step 3.
- **Recovery:** if step 3 fails after step 2, the invite is unconsumed and redemption can be retried.
  Step 2 is a no-op once verified (it must not revoke the session it just issued); membership is unique per
  team and user, so a retry never joins twice.

## Access tokens [self-study]

- Signed JWT, **algorithm fixed to HS256** with a cryptographically random server secret from env (never a
  memorable password). Key generation and rotation procedures go in `SECURITY.md`. Verification rejects any other
  `alg` (including `none`), then checks the signature, `exp` (clock-skew allowance is config), and the
  expected `iss` and `aud`.
- Claims: user ID, session (family) ID, `iat`, `exp`, `iss`, `aud`. **No role, no team.**
- Lifetime: config, in minutes, in an ADR.
- **Session check on every authenticated request**, read from shard A's **primary**: the token's family
  exists, belongs to the token's user, is not revoked, and hasn't reached its absolute expiry. Anything
  else → 401. So logging out everywhere, a password reset, and detected refresh-token theft all
  stop existing access tokens on their next request, as OWASP recommends. **Cost:** one extra primary read
  per authenticated request; the k6 report shows it.

## Refresh tokens and sessions [self-study]

- A long random opaque value, stored only as a hash on shard A, in a **token family** (one per device
  login). *SHA-256 is fine here: unlike a password, the token is high-entropy random data.*
- **Expiry:** each token has an idle expiry, each family an absolute lifetime (config, in an ADR).
  Expired → 401 and a fresh login.
- **Rotation is one transaction:** lock the family row (`SELECT … FOR UPDATE`); check the family isn't
  revoked or past its absolute expiry; consume the presented token with one conditional update requiring
  it to belong to that family, `used_at IS NULL`, not revoked, and not past its idle expiry; insert its
  replacement; commit.
- **Revocation takes the same family lock** (log out everywhere, reset, reuse), so a refresh either
  commits first and is then revoked, or runs after and sees the revocation. No usable token survives it.
- **Reuse detection (chosen policy):** a token that is already used or revoked → revoke the whole family,
  **commit that revocation, then** return 401 and log a security event. Signalling the 401 by throwing
  inside the transaction would roll the revocation back. The user's other families are untouched.
- **No grace window.** The app keeps one refresh in flight. A lost response still looks like reuse on the
  next refresh and forces a login: **accepted trade-off, documented in `SECURITY.md`.**
- **Two simultaneous refreshes:** the first returns a new token; the second is reuse and revokes the
  family, killing that new token. Expected and tested.

## Password reset

- Same response whether or not the email exists. The token is random, stored hashed, single-use and
  expiring (config); the email goes out from a job.
- **Submitting a reset token is rate limited too.** Consumption is atomic; success sets the new hash and
  revokes all the user's families.

## Invites

- **Who may invite:** Owner may invite as Manager or Staff. Manager may invite as Staff only. Nobody is
  invited as Owner.
- The authoritative invite lives on the team's shard (`data.md`): token hash, expiry, granted role, and for
  email invites the intended address.
- **Every invite token is single-use**, consumed atomically.
  - **Email invites** require the joining account's email to match the invited address. Successful
    server-side validation and **explicit redemption** of the email-bound token verifies that address,
    under the account-verification policy above.
    Merely opening a page never consumes or verifies anything: email scanners open links automatically.
  - **Signup email verification is deferred** (documented initial policy). An unverified address grants no
    trusted identity privileges and can't satisfy an email-bound invite except through that redemption.
  - **Link invites** are bearer links: whoever holds the link may use it, once. *(Not built: the design
  removed them, Figma 292:1026.)*
- **Seat capacity is claimed atomically** in the consumption transaction: one conditional update on the
  team's billing row (e.g. `seats_used = seats_used + 1 WHERE seats_used < seat_limit`). Zero rows → the
  team is full, nothing is consumed. *Why: two separate checks could both take the last seat.* Seat limits
  per plan are in `money.md`.
- The deep link carries `<teamId>.<secret>` (ADR 0015). The team ID is only a **routing hint**: it picks the
  shard, as for every team route, and the query is `WHERE team_id = ? AND token_hash = ?`. The secret is the
  credential, and only its hash is stored. Team and role come from the server's invite row, never from the
  link. **Unknown, malformed, wrong-team, expired, used and revoked tokens all answer identically**
  (`404 invite_unavailable`), **except** that the one account that already accepted this exact token, and
  still has the membership, gets the same success again so a retry is safe (ADR 0015); it writes nothing. **The preview mirrors this** (ADR 0017): the same
  account, with a valid session, gets `200 { status: "already_member", team, role }` instead of the 404, so the app takes it to its team; every other caller of a
  spent link, signed in or not, still gets the identical 404. *Why: no token-hash lookup table on shard A, and it keeps working if a large
  team is moved to its own shard.*

## Request validation (brief, Requirement 4; scope from `AGENTS.md`)

- Zod validates **body, query and route params** on every route. Objects are strict: unknown keys rejected.
- IDs are UUIDs. `limit` has a server-side maximum (config). The feed cursor is decoded, then validated
  field by field. *Why: it's attacker-controlled; an unbounded `limit` is a DoS.*
- Validation errors return 400 without echoing sensitive input.

## Rate limiting

- In Valkey, never in memory. Per IP and per user (or per submitted email before there is a user). Every
  key has a TTL. Thresholds are config, recorded in `SECURITY.md`.
- **Limited:** signup, login, magic-link request and redemption, refresh, reset request, reset-token submission, invite creation and
  acceptance, payment initiation, and the activity feed (expensive at 200 concurrent users).
- **When Valkey is unreachable or rejects a write** (possible under `noeviction`): everything above fails
  closed with 503, **including the feed** (Dave decided on 2026-10-26, issue #11, ADR 0022: failing open would
  leave the most expensive read unprotected exactly when the limiter is gone, and no alerting exists yet).
- Don't trust `X-Forwarded-For` until the host's proxy setup is verified.

## Secrets

- Server env vars only, names (no values) in `.env.example`. `SECURITY.md` lists every `EXPO_PUBLIC_`
  variable and why each is safe to expose.
- **Release gate:** search the full Git history (brief: `sk_`, `secret`, `password`, `_KEY`) and GitHub's
  secret scanning alerts. A key that was ever committed is **rotated at the provider**.
- Suspected secret in a proposed commit: stop, identify it without exposing its value, remove it.

## Safe logging

- Never log or send to Sentry: passwords, hashes, any token, `Authorization` headers, cookies, Stripe or
  Resend secrets, email bodies with links. One redaction list serves the logger and Sentry's event filter;
  auth request bodies are never logged.

## SECURITY.md: eight threats

Each gets what it is, how it's handled, and its proving test:
1. Staff calling Manager-only endpoints directly.
2. Reading another team's data by changing an ID.
3. A stolen access token.
4. A stolen refresh token, and reuse.
5. Credential stuffing and brute-force login.
6. Secrets extracted from the app bundle.
7. Forged or replayed Stripe webhooks.
8. Theft or reuse of invite and reset tokens.

Also covered, not counted: hostile cursor and limit input, secrets in Git history, log leakage.

## Tests (acceptance criteria)

1. **Staff delete-shift** (brief): Staff token → 403; the shift still exists.
2. **Team isolation** (brief): team X requesting team Y's shift → 404, with X and Y on different shards.
3. **Role from server:** demote a Manager, reuse their access token on a Manager endpoint → 403.
4. **Token verification:** wrong `alg`, `none`, tampered signature, expired, wrong `iss` or `aud` → 401.
5. **Rotation:** a refresh returns a new token; the old one is rejected; an expired token or family → 401.
6. **Reuse:** reuse an old token → 401, and the revocation is committed; the family's newest refresh token and its access tokens are
   rejected on their next request; another device's family still works.
7. **Concurrent refresh:** two simultaneous refreshes → one success response, then that new token is
   rejected because the family was revoked.
8. **Revocation race:** run log-out-everywhere during a refresh → no usable token survives.
9. **Log out everywhere:** existing access and refresh tokens of every family are rejected immediately.
    A token whose family is missing, belongs to another user, or is past its absolute expiry → 401.
10. **Password hashing:** stored value ≠ password; correct verifies; wrong fails; same password twice →
    two different hashes.
11. **Reset:** works once; reuse and expiry fail; afterwards all sessions are rejected; known and unknown
    emails get identical responses.
12. **Invites:** single use; expired, revoked and wrong-team tokens fail with one identical answer; a Manager
    can't grant Manager; an email mismatch fails; opening the preview consumes nothing; acceptance without an
    authenticated identity fails; two concurrent acceptances by the same person → one membership. *(Two
    acceptances for the last seat → exactly one succeeds arrives with seat limits in the billing slice.)*
13. **Validation:** unknown key, non-UUID path ID, oversized `limit`, tampered cursor → 400 each.
14. **Rate limits:** repeated logins → 429 **without running password verification**; with Valkey down,
    login → 503.
15. **Webhook:** an invalid signature is rejected before the body is parsed; nothing is recorded.
16. **Magic link:** works once; reuse and expiry fail; a `GET` of the link consumes nothing; unknown and
    known emails get identical responses.
17. **Account takeover blocked:** register someone else's email (unverified), keep a session; the real owner
    redeems a magic link → the old password fails and the old session is rejected *(slice 2b)*. For an
    **invite**, acceptance verifies the address and clears nothing (ADR 0015): the password and sessions stay
    intact. Retry an invite whose step 3 failed → one membership, and the session survives.
18. **Redaction:** after login, refresh and reset, captured logs and Sentry events contain no password,
    hash or token, including magic-link tokens.
