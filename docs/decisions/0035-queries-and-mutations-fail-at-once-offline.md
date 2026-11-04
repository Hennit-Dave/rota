# 0035: Every query and mutation fails at once offline (a QueryClient default)

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-11-04
- **Decided by:** Dave (2026-11-04): audit every query, then set it as the default or fix each one, my recommendation.
- **Related:** ADR 0034 (found by its proof), `.agents/rules/app-state.md`, `docs/STATE.md`

## Problem

TanStack's default network mode, `'online'`, **pauses** a query or mutation while the device is offline. A paused query never starts and never fails, so its screen waits on a skeleton for ever. Each time, one query had to remember to opt out with `networkMode: 'always'`, and one forgot: the invitation preview, the activity feed, and now `/auth/me` and the team list (`useMe`, `useTeams`), which left an offline start on "Getting your week ready" for good, so the saved shifts of ADR 0034 could never be shown.

## Options considered

1. **Fix each query** (add the line to `useMe` and `useTeams`). Quick, and the same mistake happens again with the next query.
2. **A QueryClient default** of `networkMode: 'always'` for queries and mutations. One place, and a new query cannot forget it. Chosen.

## Audit (every `useQuery`, `useInfiniteQuery`, `prefetchQuery` and `useMutation` in `app/src`)

Set explicitly already: settings, swaps, shifts, billing (every query and the two query-option helpers), invitations, the invitation preview, the activity feed, team detail and members, the settings prefetch and the new upcoming-shifts query, and every mutation. **Missing it:** `auth/useMe.ts`, `teams/useTeams.ts` (both on the launch path), and `app/dev-api.tsx` (the development-only health check). `settings/useSettings.ts` has one `skipToken` observer of `['me']` that never fetches.

## Decision

`api/queryDefaults.ts` sets `queries: { networkMode: 'always', retry: shouldRetryQuery }` and `mutations: { networkMode: 'always', retry: 0 }`, and `services.ts` builds the QueryClient from it. The per-query lines stay as a second statement of the same rule.

## Consequences (all intended)

- Offline, the request starts and the API client refuses it with an `OfflineError` (nothing is sent); each screen already maps that to its offline state. `OfflineError` is not retryable, so nothing loops.
- Nothing in the app reads a `paused` fetch status (searched). Coming back online still refetches stale queries: `refetchOnReconnect` does not depend on the network mode.
- A mutation can never be queued and replayed later, including any added in future. That is the rule in `app-state.md` (a delayed write would overwrite a newer change made elsewhere), now enforced by default instead of by memory.
- A test (`api/queryDefaults.test.ts`) fails if the default is lost, if a query that says nothing pauses (with a control that shows the unfixed client really does pause), if a mutation is parked offline, or if any source file opts back in to `'online'` or `'offlineFirst'`.

## Evidence

The emulator in airplane mode: before, a cold start stayed on the skeleton for over 80 seconds; after, it reaches the offline state, and with ADR 0034 the saved shifts. See the offline-shifts PR.
