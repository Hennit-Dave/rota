---
name: auth-tokens
description: Procedure for Rota sign-in, token refresh and sign-out across server and app - access tokens with the session check, refresh-token families with rotation and reuse detection, magic link, secure-store storage, one refresh in flight, and full local sign-out. Use when building or changing login, refresh, logout, reset or magic link.
---

# Auth tokens

Policy lives in `.agents/rules/security.md` (passwords, login, magic link, account verification, access
tokens, refresh tokens, reset, rate limiting) and `.agents/rules/app-state.md` ("API client and tokens",
"Signing out and switching accounts"). Data placement and primary-only reads: `data.md`. Paths are from
the repo root. Lifetimes, expiries and cost settings are config chosen in an ADR; never invent them.

**Self-study topics touched:** why AsyncStorage is unsafe for tokens; refresh-token rotation and reuse
detection. On first touch, name them and prompt Dave's own-words `LEARNING-LOG.md` entries.

## Steps — server

1. **Plan and wait for "go".** Name the endpoints, the ADR values still needed, and the tests.
2. **Every endpoint** follows its route type in `security.md`'s pipeline table (public auth: Zod, then
   rate limit, then handler) and the `add-api-endpoint` skill.
3. **Login / magic link:** follow `security.md` exactly, including identical responses for unknown
   emails and redemption only by `POST`. Emails go out from a job (`background-job` skill).
4. **Issue** an access token with exactly the claims and checks `security.md` lists, and a new refresh
   token family stored as hashes on shard A.
5. **Session check** on every authenticated request, against shard A's primary.
6. **Refresh:** the single locked transaction `security.md` specifies. On reuse, commit the family's
   revocation first, then return 401.
7. **Logout / log out everywhere / reset:** revoke under the same family lock.

## Steps — app

8. Store tokens only in `expo-secure-store` (`AGENTS.md` rule 4). Never in AsyncStorage, query caches or logs.
9. One API client: attach the token; on 401, one shared refresh in flight; handle each refresh-failure
   category as `app-state.md` lists.
10. Logout: server revoke when online, then the local steps in `app-state.md` (epoch, caches, persister,
    tokens), in that order.
11. Run the app-side checks on a real device.

## Tests

`security.md` tests for tokens, rotation, reuse, concurrent refresh, revocation race, logout everywhere,
reset, magic link and rate limits; `app-state.md` tests 8–11 and 15. Each must pass without relaxing a
rule (`AGENTS.md`: stop and ask instead).

## Worked example: two refreshes at once

Several requests get 401 together → the app's client makes **one** refresh call (`app-state.md`). If a
second refresh does reach the server (another device's copy of the same token, say), the first wins and
the second is reuse: the family is revoked and committed, and the first's new token stops working too.
That is the expected, tested behaviour (`security.md`), not a bug, and the accepted trade-off of no grace
window is documented in `SECURITY.md`.

## Common mistakes

- Putting role or team in the token.
- Skipping the session check "for speed".
- Read-then-write token consumption in two steps.
- Throwing inside the transaction to return the reuse 401 (rolls back the revocation).
- A `GET` that redeems a magic link.
- Any token in AsyncStorage, the TanStack cache, a log line or an `EXPO_PUBLIC_` variable.
- Replaying a refresh whose response was lost.
