# Security

Status: **partial**, written as slices land (PR A server authentication, PR B app scaffold). The eight-threat list (brief, Requirement 4) is
completed in later slices; sections below are added by the slice that builds the control.

| # | Threat | Status |
|---|---|---|
| 1 | Staff calling Manager-only endpoints directly | Written below (Teams and roles); the brief's delete-shift test is in `shifts.integration.test.ts` (slice C1) |
| 2 | Reading another team's data by changing an ID | Written below (Teams and roles) |
| 3 | A stolen access token | Written below (PR A) |
| 4 | A stolen refresh token, and reuse | Written below (PR A) |
| 5 | Credential stuffing and brute-force login | Written below: rate limiting and passwords (PR A) |
| 6 | Secrets extracted from the app bundle | Written below (PR B); the bundle check on a release build comes with the preview build |
| 7 | Forged or replayed Stripe webhooks | Not yet written (needs payments) |
| 8 | Theft or reuse of invite, reset and magic-link tokens | Invite tokens written below (Invites, slice 2a); reset and magic-link tokens in "Threat 8b" (slice 2b) |

## Permissions: the one table (threat 1)

One module, `server/src/teams/permissions.ts`, decides every permission; this table mirrors it and `permissions.unit.test.ts` checks the two
against a hand-written copy. Anything not in the table is refused. Rows without a route yet are for later slices.

| Action | Owner | Manager | Staff | Route today |
|---|---|---|---|---|
| `team.view`, `members.list` | yes | yes | yes | `GET /teams/:teamId`, `GET /teams/:teamId/members` |
| `shifts.view` | yes | yes | yes | `GET /teams/:teamId/shifts`, `GET /teams/:teamId/shifts/:shiftId`, `GET /teams/:teamId/activity` |
| `shifts.edit` | yes | yes | no | `POST /teams/:teamId/shifts`, `PATCH` and `DELETE /teams/:teamId/shifts/:shiftId` |
| `swaps.request` | yes | yes | yes | `GET` and `POST /teams/:teamId/swaps`, `GET /teams/:teamId/swaps/:swapId`, `POST …/:swapId/cancel` (the requester only) |
| `swaps.approve` | yes | yes | no | `POST /teams/:teamId/swaps/:swapId/approve` and `/reject` (never by a person who is part of the swap, except an Owner who is the only approver) |
| `preferences.edit` (own) | yes | yes | yes | later |
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

**The brief's test.** "Staff calls delete-shift and is rejected": `DELETE /teams/:teamId/shifts/:shiftId` with a Staff token answers `403 forbidden`, and the shift and its history row are still there afterwards (`shifts.integration.test.ts`, "THE BRIEF"). Staff may view the schedule but every write (create, edit, delete) is refused with nothing written. **Swaps (slice S1).** A Staff member who calls approve or reject directly, as the requester or the other person or anyone else, gets `403` and the request, both shifts and the feed are untouched (`swaps.integration.test.ts`, "THE SECURITY TEST"). A person who is part of a swap cannot decide it ("A PARTY CANNOT DECIDE THEIR OWN SWAP"; `rules.unit.test.ts`). **What remains.** `billing.manage` and the settings routes get their routes in later slices on the same middleware.

**Proving tests.** `shifts.integration.test.ts`: "THE BRIEF", "a Staff member can view the schedule but cannot publish or change a shift", "ROLE FROM THE SERVER" (a demoted Manager is refused on the next request with the same token). `team-security.integration.test.ts`: "ROLE ENFORCEMENT" (Staff 403, Manager and Owner 200, Staff still allowed to view),
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

**What remains.** Team routes added later must use `requireTeamRole` and filter every query by `team_id`; a route that skips it is the risk. The shift routes follow it: a shift ID from another team is a 404 under my team's path, and the assignee of a shift must be a member of this team.

**Proving tests.** `team-security.integration.test.ts`: "TEAM ISOLATION" (users from team X and team Y, **on different shards**, shown by SQL and the
shard function: 404 on the team and its members, byte-identical to an unknown ID, in both directions), the Staff variant, and "a removed member
loses access on the next request". `shifts.integration.test.ts`: the same isolation for the shift routes (a member of team X gets the same 404 on list, create, update and delete for team Y as for an unknown team, across shards) and "a shift ID from ANOTHER team is not found under MY team's path". Mutation-checked (shift delete without the `team_id` scope fails them): making the middleware answer 403 for a stranger, or skipping the role check, fails them.

## Threat 8 (invite tokens): theft or reuse of an invitation link

**What it is.** An invitation link is a credential that lets someone join a team in a role. It travels by email, so it can be forwarded, read by a scanner, or found in a database dump.

**How it is handled** (ADR 0015).
- The link is `https://rota.davebuilds.design/invite/<teamId>.<secret>`. The secret is 32 random bytes (base64url, 43 characters); **only its SHA-256 is stored**. The team ID is a routing hint only.
- **Single use**, consumed by one conditional update (`accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`), so two simultaneous acceptances give one membership.
- **Tied to one email address.** Accepting needs a signed-in account whose address equals the invited address (`403 invite_wrong_account` otherwise, nothing granted). So a forwarded or leaked link alone does not let anyone else join.
- **Expires after 7 days** from creation or resend. A resend gives a new secret and kills the old link at once; a revoke kills it too.
- **One answer for every unusable link:** unknown, malformed, wrong team ID, expired, used and revoked all give the identical `404 invite_unavailable`, so a response never reveals which. The one exception is the **account that already accepted** this exact link and still has the membership: it gets the same success again (a retry after a lost response, or a double submit), and nothing is written. Everyone else, including a different signed-in account, still gets the identical 404. **The preview mirrors this** (ADR 0017): the same account, with a valid session, gets `200 { status: 'already_member', team, role }` instead of the 404, so the app can take them to their team; every other caller of a spent link, signed in or not, gets the identical 404.
- **Opening a link consumes nothing:** the preview is a `POST` (the token never sits in an access log) and changes no row; only an explicit accept does.
- The role comes only from the invitation row. Nobody can be invited as Owner (validation, the permission table, and a database CHECK). A Manager can invite Staff only.
- **Never in logs:** the logger cannot carry a token, a link or an address. The raw secret exists only in the link and in the email job's stored payload until the email is sent or skipped, then the body is scrubbed from the row.

**Accepted gaps (written down on purpose).**
- **A pre-registered address blocks the invitation until the real owner takes the account over.** Signup verification is deferred, so anyone can register someone else's address. The invite can only be accepted by the account that holds that address; password reset or a magic link (slice 2b, below) is how the real owner takes such an account over. Accepting an invite deliberately does **not** clear the password or revoke sessions (ADR 0015; `security.md` amended).
- The raw token sits in the work row's payload until the job finishes, and stays on a row that ended `failed` (a human may retry it). Because acceptance is tied to the invited address and the token lasts 7 days, that alone does not let a reader join the team.
- The invite email goes out from a verified domain with a team name and inviter name that people type themselves, so an Owner could write a misleading team name. Names are escaped and single-line; team creation is rate limited.
- The link host is GitHub Pages (`site/`, ADR 0019). Until its DNS record is live and Android reports the domain verified, a link tapped in a real inbox opens the browser; the proof is `adb shell pm get-app-links` plus a tapped link (issue #35). The landing page shown without the app is static, shows no token and sends no referrer, but the host's own request logs still see the path.
- **In the app (ADR 0017):** the token lives only in the route (memory) and as route params to login and signup; it is never stored, logged, put in a query key or shown. **When Sentry is initialised for the app, route params and `/invite/` URLs must be scrubbed from breadcrumbs.** Opening a link only previews; accepting is an explicit tap, sent once (a latch), never queued offline.
- **Proof limits:** adb proofs put the link in the emulator's system log (the adb daemon logs the shell command), so device logs are never attached to a PR. Test data only.

**Proving tests.** `invites.integration.test.ts`: "create" (hash only, the secret never in the invitations row), "unavailable is ONE answer", "accept" (role from the invitation, nothing cleared, session intact), "accept needs a signed-in account...", "two simultaneous accepts", "a join that fails halfway", "preview consumes nothing", "preview mirrors accept", "REDACTION". `invites-limits.integration.test.ts`. `tokens.unit.test.ts`.

**Invite links (ADR 0025, issue #37).** A link is the other half of "invite by email or link": a Staff invitation **not tied to an email address**, usable once by whoever holds it. What changes against the email threat above, and what does not:
- **A bearer credential.** Anyone who sees the link first can use it first. It is bounded: **Staff only** (a Manager is invited by email, where the address is the second factor; the API, the permission table and a database CHECK all refuse a Manager link), **single use** (the same conditional `UPDATE` as an email invitation, so five simultaneous acceptances give one membership), **48 hours** (`INVITE_LINK_EXPIRY_HOURS`, chosen), **revocable** by an Owner or Manager, and **capped** at 10 pending per team (`INVITE_LINK_MAX_PENDING`, counted under a lock on the team row).
- **Same token design.** `<teamId>.<secret>`, 32 random bytes, only the SHA-256 stored, the **link shown once** in the creation answer and nowhere else. The same `404 invite_unavailable` for unknown, malformed, wrong-team, expired, used and revoked links, in preview and in accept.
- **No address, so no match and no verification.** Any signed-in account may accept it. Accepting **does not verify** an email address (a link proves nothing about one), so an unverified account stays unverified.
- **An existing member is never touched.** Opening a link as someone already on the team answers `already_member` with the role they hold, does not consume the link, and never changes a role. The account that already used a link gets the same success again (a lost answer is safe to retry).
- **Race losers.** A loser's directory row is taken back if they are not a member, so the directory is not left pointing at a team they are not in (best effort; the orphan sweep, issue #33, covers a failure).
- **Creating sends no email**, so it has its own limits (`invite_link_user`, `invite_link_team`) and never uses the app-wide email cap.
- **Proving tests.** `invite-links.integration.test.ts`: the single-use race, the identical answer for every unusable link, Staff only (API and CHECK), the existing-member case, no address verification, the cap under concurrency, the limits, and the production app serving the route.
- **Weakness, written down.** Nothing says who a link was meant for; the activity record shows who accepted it. If a link leaks before it is used, whoever uses it first gets in as Staff, until the Owner or Manager revokes it (visible in the pending list) or it expires.

## Threat 8b (reset and magic-link tokens): theft, reuse, enumeration and takeover

**What it is.** A reset or magic-link token is a credential that sets a password or starts a session. It travels by email, so it can be forwarded, read by a scanner, or found in a database dump; and the request that asks for it can be used to find out which addresses have accounts.

**How it is handled** (ADR 0020).
- The token is 32 random bytes (base64url); **only its SHA-256 is stored** in `auth_tokens` on shard A. **Single use**, consumed by one conditional update (`used_at IS NULL AND expires_at > now()`), so two simultaneous redemptions give one winner. **Magic link 10 minutes, reset 1 hour** (config). A newer request replaces an older unused token of the same purpose; a successful reset kills every other outstanding token of that user.
- **One answer for every dead link** (unknown, malformed, used, replaced, expired): `404 link_unavailable`.
- **Opening a link consumes nothing.** The link opens an app screen; only the screen's `POST` redeems it, so an email scanner fetching the link changes nothing. The app never stores, logs or caches the token.
- **No enumeration.** A request answers `202 { ok: true }` whether or not the address has an account, **and in the same time**: the token is made after the answer is sent (measured 135 ms against 134 ms; before, 1020 ms against 152 ms). The per-address and per-IP limits count unknown addresses too, so a 429 reveals nothing, and the daily email cap is counted only for emails that would really be made.
- **Takeover blocked.** Redeeming a magic link for an **unverified** address verifies it, **clears the existing password and revokes every session** in the same transaction (whoever registered it first may not own it); a reset also verifies the address. A verified account loses nothing when it redeems a magic link.
- **A reset ends every session** (all families revoked under the same lock as refresh, reason `password_reset`) and **does not sign anyone in**.
- **Rate limits** (`magic_request_ip` 30 and `magic_request_email` 5 per 15 minutes, `magic_redeem_ip` 30 per 15 minutes, the same for reset, `reset_submit_ip`), fail closed with `503` when Valkey is down, and a blocked attempt never reaches an Argon2 run. Daily cap: 30 emails per UTC day, shared with nothing else but Resend's 100 (invites keep 50).
- **Never in logs:** the logger cannot carry a token or an address; the tests check the captured logs. The raw token exists only in the link inside the frozen email payload until the email job has sent or skipped it, then the body is scrubbed.

**Accepted gaps (written down on purpose).**
- **Recovery can be starved.** Someone who knows real addresses can use up the 30 daily emails, or an address's 5 requests per 15 minutes, and delay a real person (ADR 0020).
- **A request replaces the link a person was about to use.** The newest email is the one that works.
- **An email can be lost after the answer** if the process dies or the database refuses between the answer and the commit; the person asks again and the failure is logged.
- **The host's request logs see the token** in the URL path (ADR 0019). The landing page shows and sends nothing.
- **When Sentry is initialised for the app, route params and `/magic/` and `/reset/` URLs must be scrubbed from breadcrumbs**, as for `/invite/`.

**Proving tests.** `recovery.integration.test.ts` (security.md tests 11, 16, 17 and 18) and `recovery.unit.test.ts`; the app's `authActions`, `authFailure`, `validation`, `recoveryApi` and `linkToken` tests.

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
| `invite_send_user` | 10 | 1 hour | `RATE_LIMIT_INVITE_SEND_USER_MAX` / `_WINDOW_SECONDS` (create and resend; approved 2026-10-23) |
| `invite_send_team` | 20 | 24 hours | `RATE_LIMIT_INVITE_SEND_TEAM_MAX` / `_WINDOW_SECONDS` (per team; counted **after** the membership check; approved 2026-10-23) |
| `invite_link_user` | 10 | 1 hour | `RATE_LIMIT_INVITE_LINK_USER_MAX` / `_WINDOW_SECONDS` (creating an invite link; mirrors `invite_send_user`; approved 2026-10-28; **chosen, not measured**; ADR 0025) |
| `invite_link_team` | 20 | 24 hours | `RATE_LIMIT_INVITE_LINK_TEAM_MAX` / `_WINDOW_SECONDS` (per team, counted after the membership check; mirrors `invite_send_team`; approved 2026-10-28; **chosen, not measured**; ADR 0025) |
| `invite_send_global` | 50 | UTC day | `INVITE_GLOBAL_DAILY_CAP` (app-wide; counted only for requests that passed every other check; resets at 00:00 UTC; approved 2026-10-23) |
| `invite_preview_ip` | 30 | 15 minutes | `RATE_LIMIT_INVITE_PREVIEW_IP_MAX` / `_WINDOW_SECONDS` |
| `invite_accept_ip` | 30 | 15 minutes | `RATE_LIMIT_INVITE_ACCEPT_IP_MAX` / `_WINDOW_SECONDS` |
| `invite_accept_user` | 10 | 1 hour | `RATE_LIMIT_INVITE_ACCEPT_USER_MAX` / `_WINDOW_SECONDS` |
| `swap_request_user` | 10 | 1 hour | `RATE_LIMIT_SWAP_REQUEST_USER_MAX` / `_WINDOW_SECONDS` (per user ID, creating a swap request only; approved 2026-10-27; **chosen, not measured**; ADR 0023) |
| `feed_user` | 120 | 1 minute | `RATE_LIMIT_FEED_USER_MAX` / `_WINDOW_SECONDS` (per user ID; approved 2026-10-26; **chosen, not measured**: the load test, with 200 distinct users, checks it; ADR 0022) |
| `settings_read_user` | 120 | 1 minute | `RATE_LIMIT_SETTINGS_READ_USER_MAX` / `_WINDOW_SECONDS` (per user ID; **proposed in the settings PR, awaiting approval; chosen, not measured**: it mirrors the feed, every foreground refetch is one read; ADR 0024) |
| `settings_write_user` | 30 | 1 minute | `RATE_LIMIT_SETTINGS_WRITE_USER_MAX` / `_WINDOW_SECONDS` (per user ID; **proposed, awaiting approval; chosen, not measured**; ADR 0024) |

The app-wide invite cap exists because Resend's free plan sends 100 emails per UTC day in total, shared with password reset and magic link (slice 2b) and any proof sends (ADR 0015). A limit keyed by the team or the whole app runs **after** the membership and role check, so a stranger cannot spend another team's budget (`security.md`).

- A blocked request is `429 rate_limited` with a `Retry-After` header, and never reaches password verification.
- If Valkey is unreachable or rejects the write, these routes answer `503 service_unavailable` (fail closed). **That includes the swap request and the activity feed** (the feed decided 2026-10-26, issue #11, ADR 0022): it returns no rows rather than serving unprotected; test "with Valkey down the feed fails CLOSED".
- **They work again on their own when Valkey is back, with no restart.** A connection that went silently dead (a laptop sleep, a NAT that forgot the mapping) is replaced after the first command timeout, so the limited routes answer 503 only while Valkey is really unreachable (ADR 0018, issue #39). An error reply such as `OOM` under `noeviction` is not a timeout and changes nothing: it still fails closed, and `noeviction` is never altered.
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
  so there is no way to answer identically. The route is rate limited. **Squatting risk:** anyone can register someone else's
  address (unverified) and hold the account until the real owner redeems a magic link or a reset (below), which verifies the address and ends the squatter's password and sessions.

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
