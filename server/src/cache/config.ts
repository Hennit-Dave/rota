/**
 * Cache settings (caching.md, ADR 0038). Every value is a config entry, so the numbers can change without a code change, and every one is a CHOSEN value, not a
 * measured one (Dave approved them on 2026-11-04). The defaults are recorded in `ARCHITECTURE.md`.
 */
export const CACHE_KINDS = ['roster', 'cal', 'feed'] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];

export interface CacheConfig {
  /** The one switch (caching.md, "Load test"): false means nothing is read from or written to the cache, so the same build runs the k6 "before" pass. */
  enabled: boolean;
  /** How long an entry lives. Also the worst case of stale data if an invalidation fails (caching.md): keep these short. */
  ttlSeconds: Record<CacheKind, number>;
  /** How long a generation key lives: longer than any entry TTL, so an entry never outlives the generation it was filled under. */
  generationTtlSeconds: number;
  /** Stop filling when Valkey's used memory is above this share of its maxmemory: the cache must never crowd out the queue (caching.md). */
  memoryLimitPercent: number;
  /** The memory check runs at most this often. */
  memoryCheckSeconds: number;
}

type Env = Record<string, string | undefined>;

// Dave, 2026-11-04. CHOSEN, NOT MEASURED.
const DEFAULT_TTL_SECONDS: Record<CacheKind, number> = { feed: 30, cal: 30, roster: 60 };
const DEFAULT_GENERATION_TTL_SECONDS = 600;
const DEFAULT_MEMORY_LIMIT_PERCENT = 70;
const DEFAULT_MEMORY_CHECK_SECONDS = 30;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return Number(raw);
}

export function loadCacheConfig(env: Env = process.env): CacheConfig {
  const rawEnabled = env.CACHE_ENABLED?.trim();
  // Strict on purpose: a typo must stop the API, not leave caching quietly on (or off) for a load test.
  if (rawEnabled !== undefined && rawEnabled !== '' && rawEnabled !== 'true' && rawEnabled !== 'false') {
    throw new Error(`CACHE_ENABLED must be "true" or "false", got "${rawEnabled}"`);
  }
  const enabled = rawEnabled === undefined || rawEnabled === '' ? true : rawEnabled === 'true';

  const ttlSeconds: Record<CacheKind, number> = {
    feed: positiveInt(env, 'CACHE_TTL_FEED_SECONDS', DEFAULT_TTL_SECONDS.feed),
    cal: positiveInt(env, 'CACHE_TTL_CALENDAR_SECONDS', DEFAULT_TTL_SECONDS.cal),
    roster: positiveInt(env, 'CACHE_TTL_ROSTER_SECONDS', DEFAULT_TTL_SECONDS.roster),
  };
  const generationTtlSeconds = positiveInt(env, 'CACHE_GENERATION_TTL_SECONDS', DEFAULT_GENERATION_TTL_SECONDS);
  if (generationTtlSeconds <= Math.max(...Object.values(ttlSeconds))) {
    throw new Error('CACHE_GENERATION_TTL_SECONDS must be longer than every entry TTL (an entry must never outlive its generation)');
  }
  const memoryLimitPercent = positiveInt(env, 'CACHE_MEMORY_LIMIT_PERCENT', DEFAULT_MEMORY_LIMIT_PERCENT);
  if (memoryLimitPercent > 99) throw new Error('CACHE_MEMORY_LIMIT_PERCENT must be from 1 to 99');
  const memoryCheckSeconds = positiveInt(env, 'CACHE_MEMORY_CHECK_SECONDS', DEFAULT_MEMORY_CHECK_SECONDS);
  return { enabled, ttlSeconds, generationTtlSeconds, memoryLimitPercent, memoryCheckSeconds };
}
