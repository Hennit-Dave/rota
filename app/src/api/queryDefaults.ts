import { shouldRetryQuery } from './errors';

/**
 * The QueryClient's defaults, in one place a test can reach (`services.ts` uses it and cannot be imported without the phone's native modules).
 *
 * `networkMode: 'always'` for queries AND mutations (app-state.md): TanStack's default ('online') PAUSES a query or mutation while the device is offline,
 * so it never starts, never fails, and its screen waits for ever on a skeleton. That bug was found three times (the invitation preview, the activity feed, and
 * `/auth/me` plus the team list at an offline start) because each query had to remember to opt out. With 'always' the request starts at once and the API client
 * refuses it with an `OfflineError` (nothing is sent), which every screen already maps to its offline state.
 *
 * Side effects, all intended:
 * - A query no longer shows `fetchStatus: 'paused'` (nothing in the app reads it). Coming back online still refetches stale queries (`refetchOnReconnect` does not
 *   depend on the network mode), so a screen that failed offline fills in when the connection returns.
 * - A mutation can no longer be queued by accident and replayed later: offline it fails at once. That is the rule (a delayed write would overwrite a newer change
 *   made elsewhere), now true for any mutation added in future, not only the ones that remembered to say so.
 * - Retries are unchanged: `OfflineError` is not retryable, so nothing loops while offline; a timeout still retries twice (`errors.ts`).
 */
export const queryClientDefaults = {
  queries: { networkMode: 'always' as const, retry: shouldRetryQuery },
  // Mutations never retry by default (a retry could send a write twice).
  mutations: { networkMode: 'always' as const, retry: 0 },
};
