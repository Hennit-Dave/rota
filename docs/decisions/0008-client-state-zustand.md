# 0008: Client state tool: Zustand, kept small

- **Status:** accepted (2026-10-21)
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** issue #8, `.agents/rules/app-state.md`, `docs/STATE.md`

## Problem

The app needs state that exists only on the phone (is the user signed in, which team is open, which message to show
after a sign-out). `app-state.md` and the brief (Requirement 2) require exactly one tool for it, justified in
`STATE.md`. Server data stays in TanStack Query and is not part of this decision.

## Options considered

1. **React state and context (no dependency):** nothing to install. Anything shared by several screens has to be lifted
   into a provider, every consumer of a context re-renders when any part of it changes, and code outside React (the API
   client, which must reset the session on a failed refresh) cannot read or change it.
2. **Zustand:** a small store with selectors, readable and writable from plain TypeScript through
   `useSessionStore.getState()`, so the sign-out sequence can reset it without a component. Pure JavaScript, no native
   code, so no native rebuild (checked: the installed package has no `android`, `ios` or `cpp` folder).

## Decision

Zustand 5.0.15, for **session status, the selected team ID and UI flags only**. One store, `app/src/state/sessionStore.ts`.

## Why

- The sign-out rule needs code that is not a component (the API client, after the server refuses a refresh) to reset client
  state. A store can be reached from there; React context cannot.
- Selectors keep a change in one field from re-rendering screens that read another.
- It stays small on purpose. It never holds server data (TanStack Query), tokens (secure-store) or anything about money
  (`AGENTS.md` rule 2: the app does no money logic of any kind).

## Consequences

- **Gap in `app-state.md`, filled here:** the sign-out steps in `app-state.md` clear the query caches, the persisted cache and
  the tokens, but say nothing about client state. Decision: sign-out **resets the store to its initial state after the epoch
  bump and the cache clear**, carrying a `signOutNotice` so the right message shows. Without this, the previous user's selected
  team would still be in memory for the next user. Order in code: epoch, caches, persisted cache, store, tokens
  (`app/src/auth/signOut.ts`, tested).
- The store is not persisted. After a relaunch the session status is rebuilt from whether tokens exist, and the selected team is
  chosen again. Whether the selected team should survive a restart is a later decision, to be made with the team screens.
- **Revisit when:** a second kind of client state appears that is shared widely and changes often, or someone wants to persist
  the store (that needs a decision about what is allowed on disk).

## Evidence

`app/src/state/sessionStore.test.ts` and `app/src/auth/signOut.test.ts` (`npm test` in `app/`).
