# Security

Status: **partial**, written as slices land (PR A server authentication, PR B app scaffold). The eight-threat list (brief, Requirement 4) is
completed in later slices; sections below are added by the slice that builds the control.

| # | Threat | Status |
|---|---|---|
| 1 | Staff calling Manager-only endpoints directly | Written below (Teams and roles). The brief's delete-shift test comes with the shifts slice |
| 2 | Reading another team's data by changing an ID | Written below (Teams and roles) |
| 3 | A stolen access token | Written below (PR A) |
| 4 | A stolen refresh token, and reuse | Written below (PR A) |
| 5 | Credential stuffing and brute-force login | Written below: rate limiting and passwords (PR A) |
| 6 | Secrets extracted from the app bundle | Written below (PR B); the bundle check on a release build comes with the preview build |
| 7 | Forged or replayed Stripe webhooks | Not yet written (needs payments) |
| 8 | Theft or reuse of invite and reset tokens | Not yet written (needs invites and reset) |

## Permissions: the one table (threat 1)

One module, `server/src/teams/permissions.ts`, decides every permission; this table mirrors it and `permissions.unit.test.ts` checks the two
against a hand-written copy. Anything not in the table is refused. Rows without a route yet are for later slices.

| Action | Owner | Manager | Staff | Route today |
|---|---|---|---|---|
| `team.view`, `members.list` | yes | yes | yes | `GET /teams/:teamId`, `GET /teams/:teamId/members` |
| `shifts.view`, `swaps.request`, `preferences.edit` (own) | yes | yes | yes | later |
| `shifts.edit`, `swaps.approve` | yes | yes | no | later |
| `invite.staff` | yes | yes | no | later |
| `invite.manager` | yes | no | no | later |
| `billing.manage` | yes | no | no | later |

Nobody is invited as Owner, and the database allows only one Owner per team (partial unique index).

## Threat 1: Staff calling Manager-only endpoints directly

**What it is.** A Staff member skips the app and calls an Owner/Manager endpoint (a shift delete, an invite, billing) with their own valid token.

**How it is handled.**
- The app hides buttons, but **the server decides**. Every team route runs `requireTeamRole(action)` after the token and session check.
- **The role is read from the database on every request** (the team shard's primary), never from the token, which carries no role. A demotion
  applies to the very next request.
- A member whose role may not do the action gets `403 forbidden`; the real reason (`role_staff_cannot_shifts.edit`) is in the server log only.

**What remains.** Only `team.view` and `members.list` have real routes so far, so the proof uses a route that exists only in the test harness.
The brief's "Staff calls delete-shift and is rejected" test belongs to the shifts slice, which adds the endpoint on this same middleware.

**Proving tests.** `team-security.integration.test.ts`: "ROLE ENFORCEMENT" (Staff 403, Manager and Owner 200, Staff still allowed to view),
"ROLE FROM THE SERVER, NOT THE TOKEN" (demote a Manager, the same token gets 403). `permissions.unit.test.ts`: the table. The test route is
checked to be absent from the production app in `teams.integration.test.ts`.

## Threat 2: reading another team's data by changing an ID

**What it is.** A user changes the team ID in a request to see a team they are not in.

**How it is handled.**
- The team comes from the validated route parameter (a canonical UUID), never from the body or the token. The membership is looked up on **that team's
  shard** for the **caller's user ID**; no membership means the request stops.
- **404, not 403.** A team the caller is not in answers exactly like a team that does not exist (same status, same body apart from the request ID), so
  a response never confirms that another team's resource exists. 403 is only for a member with too little power.
- Team data is tied to the team's shard; there is no cross-team query on a request path.
- A removed member loses access on the next request (membership is read from the primary every time), even if the directory still lists them
  (ADR 0013: the directory is a hint, access never consults it).

**What remains.** Team routes added later must use `requireTeamRole` and filter every query by `team_id`; a route that skips it is the risk.

**Proving tests.** `team-security.integration.test.ts`: "TEAM ISOLATION" (users from team X and team Y, **on different shards**, shown by SQL and the
shard function: 404 on the team and its members, byte-identical to an unknown ID, in both directions), the Staff variant, and "a removed member
loses access on the next request". Mutation-checked: making the middleware answer 403 for a stranger, or skipping the role check, fails them.

## Threat 3: a stolen access token

**What it is.** Someone obtains a valid access token (a leaked log, a shared device, a proxy) and sends it as `Authorization: Bearer`.

**How it is handled.**
- The token lives 15 minutes (ADR 0005). It carries only the user and the session (`sub`, `sid`): no role and no team, so stealing it
  gains no permission the server doesn't re-check on every request.
- **Every authenticated request re-checks the session on shard A's primary** (`isSessionActive`): the family exists, belongs to
  the token's user, is not revoked and is inside its absolute expiry. So logout, logout-all and a detected refresh-token theft stop
  a stolen access token on its very next request, not 15 minutes later.
- HS256 is fixed. `alg: none`, any other algorithm, a wrong key, a wrong issuer or audience, and an expired token are all refused,
  with one public answer (`401 unauthenticated`, `WWW-Authenticate: Bearer`); the real reason is only in the server log.
- Token-bearing responses are `Cache-Control: no-store`. Tokens are never logged: the logger accepts a fixed list of fields and cannot
  be handed a header or a body.

**What remains.** Until the session is revoked or the token expires, a stolen access token works, and nothing tells the owner. The cost
of the check is one primary read per request, which the k6 report must measure.

**Proving tests.** `session-check.integration.test.ts` (revocation stops the same token on its next request; expired family;
family of another user; `none`, HS512, wrong secret; roles ignored), `tokens.unit.test.ts` (every verification failure),
`middleware.unit.test.ts`, `refresh.integration.test.ts` ("redaction": no token in any log line), `logout.integration.test.ts`.

## Threat 4: a stolen refresh token, and reuse

**What it is.** Someone copies a refresh token (the long-lived credential) and uses it to mint new access tokens.

**How it is handled.**
- A refresh token is 32 random bytes. Only its SHA-256 is stored; the token itself never is. A session is a *family* of tokens, one family
  per device login.
- **Rotation:** every refresh consumes the presented token and issues a replacement, in one transaction that locks the family row
  (`FOR UPDATE`) and consumes the token with one conditional update. Two simultaneous uses of one token give exactly one winner.
- **Reuse detection:** presenting a token that was already used revokes the whole family and **commits that revocation before** the
  401 goes out (the outcome is returned from the transaction, never thrown inside it). The newest refresh token and the family's access
  tokens stop working; the user's other devices are untouched.
- **Logout** revokes one family; **logout-all** revokes every family of the user. Both take the same lock as refresh, and logout-all
  locks families in id order, so a refresh in flight either commits first and is then revoked, or runs after and sees the revocation.
- Limits: 30 days idle, 90 days absolute per family (ADR 0005); refresh is rate limited by IP (`refresh_ip`, below).
- Failure answers are identical for unknown, idle-expired, expired, revoked and reused tokens. The reason (`refresh_reuse_detected`, ...)
  is in the log only; reuse also writes a `refresh_reuse_detected` security event naming the user and family.

**Accepted trade-offs.**
- **No grace window.** A refresh whose response is lost looks like reuse on the next refresh and forces a new login. The app keeps one
  refresh in flight to make this rare.
- A thief who refreshes *first* and keeps rotating while the owner is offline holds a session until the owner returns and presents the
  now-old token (detected then, and the family dies). Used tokens are kept until their family expires so reuse can be seen; a purge job
  is a follow-up (issue #20).
- A login that starts while logout-all is running makes a new family that logout-all does not cover.
- If the database can't start the transaction in time, the answer is a retryable `503`; nothing was consumed.

**Proving tests** (numbers are `security.md` / `data.md` acceptance tests). `refresh.integration.test.ts`: rotation (5), reuse (6). `concurrency.slow.test.ts`: concurrent refresh (7), atomic consumption, revocation race (8) deterministic in both
orders and repeated 15 times, no deadlock between logout, logout-all and refresh. `logout.integration.test.ts`: logout ends one device, logout-all ends all (9).

## Rate limiting (threat 5: credential stuffing and brute force)

Held in Valkey, never in memory (ADR 0007). Fixed windows, keyed by a hash of the IP or the email.

| Rule | Limit | Window | Env override (max / window seconds) |
|---|---|---|---|
| `login_ip` | 30 | 15 minutes | `RATE_LIMIT_LOGIN_IP_MAX` / `_WINDOW_SECONDS` |
| `login_email` | 5 | 15 minutes | `RATE_LIMIT_LOGIN_EMAIL_MAX` / `_WINDOW_SECONDS` |
| `register_ip` | 10 | 1 hour | `RATE_LIMIT_REGISTER_IP_MAX` / `_WINDOW_SECONDS` |
| `refresh_ip` | 60 | 15 minutes | `RATE_LIMIT_REFRESH_IP_MAX` / `_WINDOW_SECONDS` |
| `team_create_user` | 5 | 1 hour | `RATE_LIMIT_TEAM_CREATE_USER_MAX` / `_WINDOW_SECONDS` (per user ID; approved 2026-10-23) |

- A blocked request is `429 rate_limited` with a `Retry-After` header, and never reaches password verification.
- If Valkey is unreachable or rejects the write, these routes answer `503 service_unavailable` (fail closed).
- The IP is the TCP peer address. `X-Forwarded-For` is not trusted until the host's proxy setup is verified.
- A set-but-invalid override (not a positive integer) stops the server from starting.

## Request IDs and logging

- Every response carries `X-Request-Id`. An incoming one is accepted only if it is a canonical UUID; otherwise a new one is made.
- One JSON log line per request: request ID, user ID (when authenticated), route **template**, status, duration, error code,
  database route. UTC ISO 8601 timestamps.
- The logger only accepts a fixed list of fields and primitive values. It cannot be handed a request body, a header, an
  email, a password or a token, so none of them can reach a log line. Error text passes through the shared redaction.
- This is the minimum. The logger library and Sentry are chosen at build step 3.

## Passwords (threat 5, with rate limiting)

- Stored as Argon2id (19 MiB, 2 iterations, parallelism 1) on shard A, in `credentials.password_hash`. Never returned, never
  logged. Library and benchmark: ADR 0006.
- Policy (NIST SP 800-63B-4, ADR 0005): minimum 15 and maximum 128 characters, counted as Unicode code points; NFC-normalised;
  no composition rules; over-long passwords are rejected, never truncated. A blocklist check exists but **its list is empty:
  NIST SHALL not yet met, no list with a confirmed data licence** (ADR 0005; tracked in `AGENTS.md`, "Later proofs").
- Login never says which of email or password was wrong: one `401 invalid_credentials`, and an unknown email still runs one
  Argon2 verification against a dummy hash so timing does not reveal accounts.
- **Accepted trade-off: `409 email_in_use` at sign-up reveals that an address has an account.** Sign-up verification is deferred,
  so there is no way to answer identically. The route is rate limited. **Squatting risk until magic link / verification
  lands:** anyone can register someone else's address (unverified) and hold the account.

## Signing secret

`AUTH_JWT_SECRET` is base64 of at least 32 random bytes (RFC 7518 section 3.2). Generate: `openssl rand -base64 32`.
The server refuses to start without it, and never logs it. It is a server environment variable only: it is never in the repo, the app
bundle or any `EXPO_PUBLIC_` variable.

**Rotating it** (on a schedule you choose, or at once if it may have leaked):
1. Generate a new value: `openssl rand -base64 32`.
2. Set it as `AUTH_JWT_SECRET` in the host's environment (and your local `.env`), then restart the API. There is a single key and no key
   ID, so the switch is immediate: every access token signed with the old key is refused (`401`) from the first request on the new process.
3. The effect on users is small and by design: access tokens last 15 minutes and the app answers a `401` with one refresh. Refresh tokens
   are random values stored as hashes and do **not** depend on this secret, so sessions survive a rotation.
4. **If the old secret leaked,** step 2 is not enough on its own to be sure: someone holding it could have signed tokens, but each token
   must name a real, live (user, session) pair, and the session check refuses any other. Ending every live session is the stronger
   response: an operator runs, on shard A, `UPDATE refresh_token_families SET revoked_at = now(), revoked_reason = 'secret_rotation'
   WHERE revoked_at IS NULL;` (not run by any code; everyone then signs in again).
5. Rotation is not exercised by an automated test yet. A second verifier, or a rotation without logging out in-flight tokens, would need
   a key ID and two accepted keys (ADR 0005, Revisit when).

## Threat 6: secrets extracted from the app bundle

**What it is.** Anyone can download the APK, unzip it and search it. Anything inside is public: a payment key in an `EXPO_PUBLIC_`
variable would let a stranger issue refunds (brief, Requirement 4).

**How it is handled.**
- **One `EXPO_PUBLIC_` variable exists, and it is not a secret** (table below). A unit test (`app/src/publicEnv.test.ts`) fails if any
  other `EXPO_PUBLIC_` name appears anywhere in the app, or if an allowed name looks secret-shaped, or if one is missing from this
  file or `.env.example`. A new variable therefore cannot be added without writing its justification here first.
- The app holds no key, no signing secret and no provider credential. The server holds every secret as an environment variable
  (`.env.example` lists names only). The app has no payment logic at all (`AGENTS.md` rule 2).
- Tokens are stored only in `expo-secure-store`, never AsyncStorage, never the query cache, never a log. Android's cloud and
  device-transfer backup rules shipped with `expo-secure-store` exclude its data, so tokens are not copied off the device by backup.
- `android/` is generated and gitignored; the Sentry source-map upload token will be an EAS build secret, never a public variable.
- **`google-services.json` (Firebase client config for push)** holds the Firebase project identifiers and a Google API key. Those
  values are shipped inside every APK by design, so they are not secret. It is still kept out of the repository (ADR 0011) so a
  public repo does not trigger secret-scanning alerts or trip the brief's `_KEY` history search. The Firebase **service-account
  private key** is the real secret: it is uploaded to EAS credentials and never enters the repo or the app.

**EXPO_PUBLIC_ variables (the complete list).**

| Variable | Value | Why it is safe to expose |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | The API's address, for example `https://api.example.com` (locally `http://10.0.2.2:<port>`) | It is only an address, and anyone with the APK or a network trace can read it anyway. It grants nothing: the server authenticates every request and decides every permission, and never trusts the client (`AGENTS.md` rule 3). The app refuses to start talking to anything that is not `https`, except the local development server in a development build (`app/src/api/config.ts`, tested). |

The Sentry DSN will join this table in the Sentry slice. A DSN can only submit events, not read them, which is why Sentry documents it
as public; that claim is checked then, not assumed now.

**What remains.** A debug build loads its JavaScript from the development server and does not contain the bundle, so the bundle search
(`unzip` the APK and search for `sk_`, `secret`, `password`, `_KEY`) is run on the first preview (release) build and recorded then.

**Proving tests.** `app/src/publicEnv.test.ts` (allowlist), `app/src/api/config.test.ts` (https only), `app/src/auth/signOut.test.ts` and
`app/src/api/client.test.ts` (token handling).
