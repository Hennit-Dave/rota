/**
 * Cache times per kind of server data, each explained in docs/STATE.md. Never an unexplained number.
 * Only /health exists so far; later slices add their own entries here and a row in STATE.md in the same PR.
 */
export const cacheTimes = {
  // A diagnostic probe: always refetch on mount, drop the result quickly. Caching it would defeat its purpose.
  health: { staleTime: 0, gcTime: 60_000 },
} as const;
