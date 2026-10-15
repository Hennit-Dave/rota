# app/ — mobile rules (additive to the root AGENTS.md)

These add to the root `AGENTS.md`; they never replace it. If they conflict, stop and ask.
All paths below are relative to the repository root.

**Loading check:** if asked for this folder's rules marker, answer `app-rules-loaded`. The marker exists
only in this file.

## Read before changing code here

| If the change touches… | Read |
|---|---|
| Fetching, caching, persisting or changing data; settings; offline shifts; sign-out | `.agents/rules/app-state.md` |
| Any dependency, `app.json`, `eas.json`, push, deep links, Sentry | `.agents/rules/expo-builds.md` |
| Tokens, login, magic links, invites | `.agents/rules/security.md` |
| Anything that shows a price, charge or payment status | `.agents/rules/money.md` (no money logic in the app) |

## App-specific checks before every PR

- No arithmetic on amounts and no plan prices anywhere in `app/`. Every figure comes from a server response.
- Persist tokens only in secure-store; never put them in query caches, general device storage or logs.
- No new `EXPO_PUBLIC_` variable without a line in `SECURITY.md` saying why it's safe.
- **Assess every new or changed dependency and config change:** does it need a new native build? If it
  does, say so and wait for "go" before installing. If it doesn't, say why (e.g. pure JavaScript).
- Only the allowlisted query is persisted; settings and swap mutations never queue offline.
- Opening a deep link never consumes a token; returning from Checkout triggers a server status check.
- Every list has loading, empty, end-of-list and error states.

## Pending before the first native build

The client state tool, the offline storage library, and the routing and deep-link library. Don't pick
them; ask. Directory layout and commands are filled in by the scaffold slice.
