/**
 * How long the saved shifts may be shown, counted from when this phone last got them from the server. CHOSEN, NOT MEASURED (Dave, 2026-11-04): a week-old
 * list of "upcoming" shifts is already unreliable, and a limit bounds how long personal data stays on a lost or lent phone. Recorded in docs/STATE.md and ADR 0034.
 */
export const OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** True when data fetched at `fetchedAt` (ms since the epoch, the phone's clock at the fetch) is older than `maxAgeMs`. */
export function isExpired(fetchedAt: number, now: number, maxAgeMs: number = OFFLINE_MAX_AGE_MS): boolean {
  return now - fetchedAt > maxAgeMs;
}
