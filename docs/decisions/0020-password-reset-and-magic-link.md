# 0020: Password reset and magic link

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-26
- **Decided by:** Dave (values approved 2026-10-26)
- **Related:** slice 2b, `.agents/rules/security.md` (Password reset, Magic link, Account verification policy, tests 11, 16, 17, 18), ADR 0005 (tokens and sessions), ADR 0007 (rate limiting), ADR 0015 (invitations), ADR 0016 (the email job), ADR 0009 and 0019 (App Links and their host)

## Problem

The brief needs a single-use, expiring password-reset token, and one of Google sign-in or a magic link (we chose the magic link). Until now a person who forgot their password, or whose address someone else had registered first, had no way in (the accepted gap in ADR 0005 and ADR 0015). Both flows start the same way (an emailed single-use token) and end differently (a magic link signs in; a reset sets a new password and ends every session), so they share one pipeline.

## Options considered

1. **Two separate token stores and email paths.** Simple to read, twice the code and twice the places to get single-use wrong.
2. **One `auth_tokens` table on shard A, one email path (the invite pipeline), two purposes.** Chosen.
3. **Put the token in the user row** (one live token per user, no table). Fewer rows, but no audit trail, no per-purpose rule, and replacing a token would be an update of the account row. Rejected.

## Decision

**Storage.** `auth_tokens` on shard A (identity data): `user_id`, `purpose` (`magic_link` | `password_reset`), `token_hash` (SHA-256 of the secret; the secret is 32 random bytes in base64url and exists only in the link inside the frozen email payload), `expires_at`, `used_at`, `email_work_row_id`. The migration adds a table only; no existing table or row changes.

**Requests** (`POST /auth/magic-link/request`, `POST /auth/password-reset/request`). One answer, `202 { ok: true }`, whether or not the address has an account. For an existing account the token row and the email work row commit together on shard A, then the job is enqueued (jobs.md: Postgres first, then the queue). A newer request replaces any older unused token of the same purpose (the older link and its queued email stop working).

**The answer is sent before the token is made (found by measuring).** Making the token, the email row and the job before answering took a median **1020 ms** for an address with an account and **152 ms** for one without (25 requests each, test shards): a difference anyone could use to list registered addresses. The handler now does the same lookup for both, answers, and makes the token in a tracked background step: **135 ms against 134 ms** after the change. OWASP's Forgot Password Cheat Sheet recommends exactly this (asynchronous work or one code path). The cost: if the process dies in that step, or the database refuses, no email is sent and the person asks again (the failure is logged; the token row and email row are still written together or not at all, and a failed enqueue leaves the committed row for the sweep). Shutdown waits for these steps.

**Redemption.**
- **Magic link** (`POST /auth/magic-link/redeem`): one atomic conditional update consumes the token (unused, right purpose, not expired). If the account's email was **unverified**, the same transaction marks it verified, **clears the password and revokes every session**, then issues the new session (security.md, account verification policy: whoever set that password may not own the address). A verified account loses nothing. Answers like login.
- **Password reset** (`POST /auth/password-reset/submit`): one transaction consumes the token, sets the new password hash (creating the credential if a magic link had cleared it), marks the address verified (a reset proves control of it too), **revokes every session**, and kills every other outstanding token of that user. It does **not** sign anyone in: OWASP advises against it, and the person logs in with the new password. The hash is made before the transaction, so no Argon2 run happens while rows are locked.
- Every unusable link (unknown, malformed, used, replaced, expired) gets one answer, `404 link_unavailable`. A `GET` of a link, or an email scanner fetching it, consumes nothing: the link opens an app screen and only the screen's `POST` redeems.

**The email job.** The existing `email` handler also checks, before stamping or sending, that the token it was made for is still live (not used, replaced or expired); otherwise the row ends `done` with no `sent_at` (same rule as a dead invitation, ADR 0016). The body is scrubbed after a send or a skip.

**Approved values (Dave, 2026-10-26):**

| Setting | Value | Basis |
|---|---|---|
| Magic-link lifetime | **10 minutes** | NIST SP 800-63B-4: an out-of-band authentication must complete within 10 minutes |
| Reset lifetime | **1 hour** | Our judgment, below NIST SP 800-63B-4's 24-hour ceiling for a recovery code sent by email. OWASP gives no number ("an appropriate period") |
| Request limits | per address **5 per 15 minutes**, per IP **30 per 15 minutes** | Mirror the login rules; counted for unknown addresses too, so a 429 reveals nothing |
| Redeem / submit limits | per IP **30 per 15 minutes** | Mirror the login IP rule |
| Daily cap on these emails | **30 per UTC day**, shared by both flows | Resend's free plan sends 100 per UTC day in total; invitations keep 50 (ADR 0015) |

All are config with env overrides (`AUTH_MAGIC_LINK_MINUTES`, `AUTH_PASSWORD_RESET_MINUTES`, `RATE_LIMIT_MAGIC_*`, `RATE_LIMIT_RESET_*`, `AUTH_EMAIL_GLOBAL_DAILY_CAP`); a set-but-invalid value stops the server.

**The daily cap** is counted only when an email would really be made (an existing account that passed the other limits). When it is spent the answer is still the same `202` and no email is made (logged as `recovery_email_cap_reached`), so a cap that runs out cannot be used to tell which addresses exist, and made-up addresses cannot burn it.

**The app** (screens from Figma 03 Authentication: magic 8:47, magic-confirm 8:61, reset 8:74, reset-new 8:86). Opening a link only shows a screen; the button redeems. The token is read from the route into memory and is never stored, logged or put in a query key (Sentry must scrub `/magic/` and `/reset/` URLs when it is added, as for invites). A signed-in person who redeems a magic link is logged out **only after the server accepted the link**, so a dead link never costs them their session (found on the emulator; recorded before the fix).

## Why

- One pipeline means one place that decides single use, expiry and the email rules, and the invite pipeline is already proven (ADR 0015, 0016).
- Hash-only storage and atomic consumption follow `security.md`; the takeover rule closes the gap ADR 0005 and ADR 0015 accepted.
- Answering before doing the work is the one way to give identical answers in identical time without writing decoy rows.

## Consequences

- **Closes** the accepted gap "a pre-registered address blocks the real person until reset exists": the real owner can now take the account over with a magic link or a reset.
- **Accepted: recovery can be starved for a day.** The cap is app-wide and the per-address limit is per address, so someone who knows real addresses can use up the 30 daily emails (and, per address, the 5 requests per 15 minutes) and delay a real person. Raising the cap needs Resend's paid plan, which is out of scope (AGENTS.md); the log line shows when it happens.
- **Accepted: a request can replace a link the person was about to use.** Someone who knows an address can make its pending link stop working by requesting another (bounded by the per-address limit). The newest email is the one that works, and the screens say so.
- **Accepted: an email lost after the answer.** See "answer before the token". The person asks again; nothing sensitive is lost.
- **The host's request logs see the link** (the token is in the URL path of `https://rota.davebuilds.design/magic|reset/<token>`), as any host would (ADR 0019). A leaked reset link is a credential for its short life; a leaked magic link is a login for 10 minutes.
- **Revisit when:** the load test or real use shows the cap or limits are wrong; a second email provider or paid plan exists; or signup verification is built (the verification rule may then simplify).

## Not in Figma (built from the login patterns; listed in the pull request)

The request screen for a magic link (the login screen's own address is used, as `8:47` shows "requested for ..."); the "sent" state of a password reset (the `8:47` layout with `8:74`'s wording); the unavailable-link screen (layout of invite-expired `8:146`); the loading, offline, rate-limited and generic-error states of all four screens (login patterns `229:269`, `229:3636`, `229:3485`, `229:3586`); the confirm-password errors; the "Password updated" banner on login; "Resend link" feedback.

## Evidence

- `server/src/auth/recovery.integration.test.ts` (25 tests, test shards, real Valkey): identical answers; hash-only storage; single use, expiry, replacement, one answer for every dead link; a `GET` consumes nothing; **account takeover blocked** (squatter's password and sessions die; a verified account loses nothing); reset ends every session and signs nobody in; weak password does not use the link up; two simultaneous redemptions or resets give one winner; rate limits (429 before any Argon2 run); the daily cap; Valkey down gives 503 on all four routes; redaction; the email job sends or skips; the answer does not wait for the token; a failure after the answer is logged and leaves the rows for the sweep. Mutation-checked: skipping the password clearing, skipping the session revocation, or allowing link reuse each fail tests.
- `server/src/auth/recovery.unit.test.ts` (9), `app` tests (+19).
- Emulator run against the real API (local Valkey, test shards, worker off): forgot password, sent screen, reset link, mismatch error, new password, login with it; magic link request, confirm, redeem while signed in and signed out, the dead link. Screenshots and the database state are kept outside the repo and linked in the pull request.
