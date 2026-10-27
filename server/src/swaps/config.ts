/**
 * Swap settings (ADR 0023). At most 3 swap requests may wait for a decision per person (approved by Dave 2026-10-27; chosen, not measured). An env var
 * overrides it; a set-but-invalid value stops the server, as for every other setting.
 */
type Env = Record<string, string | undefined>;

export interface SwapsConfig {
  /** The most requests one person may have waiting for a decision at once. */
  maxPending: number;
  /** The most requests one list answer carries (newest first). */
  listLimit: number;
}

export function loadSwapsConfig(env: Env = process.env): SwapsConfig {
  const raw = env.SWAPS_MAX_PENDING;
  let maxPending = 3;
  if (raw !== undefined && raw !== '') {
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`SWAPS_MAX_PENDING must be a positive integer, got "${raw}"`);
    maxPending = Number(raw);
    if (!Number.isSafeInteger(maxPending)) throw new Error('SWAPS_MAX_PENDING is too large');
  }
  return { maxPending, listLimit: 50 };
}
