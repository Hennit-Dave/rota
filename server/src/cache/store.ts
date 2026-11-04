import { randomUUID } from 'node:crypto';
import type { Logger } from '../http/logger.js';
import { recycleIfStale } from '../jobs/connection.js';
import { sanitizeError } from '../jobs/redact.js';
import type { CacheConfig, CacheKind } from './config.js';
import { entryKey, generationKey, type Scope } from './keys.js';

/**
 * The team cache (caching.md, ADR 0038): cache-aside over Valkey for exactly three kinds of data (the roster, the shift calendar and the first page of the
 * activity feed). The `CacheKind` type is the whole list: nothing else can be cached through this module, so sessions, permissions, billing, payment status,
 * credit balances and idempotency records cannot end up here by accident.
 *
 * Reading: the generation is read FIRST, then the entry. A miss fills from the PRIMARY (a fill from a lagging replica would store stale data), under the
 * generation read before the database was, with a TTL. Writing: the writer replaces the generation AFTER its transaction commits. A fill that was already
 * reading the database lands under the old generation, which no reader looks up any more, so an in-flight old read cannot refill the cache after an
 * invalidation. Entries are never deleted one by one; they expire.
 *
 * A cache failure is never a request failure and never blocks Postgres: every Valkey problem is caught here, logged once per outage, and the read falls back to
 * the database. The one failure the caller still sees is the rate limiter's (security.md), which is not this module.
 */

export type CacheStatus = 'hit' | 'miss' | 'bypass' | 'off' | 'error';

/** The part of an ioredis connection the cache uses. `status`, `disconnect` and `once` let a half-open connection be replaced (jobs/connection.ts). */
export interface CacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
  info(section: string): Promise<string>;
  status: string;
  disconnect(reconnect?: boolean): void;
  once?(event: 'close', listener: () => void): unknown;
}

/** What a writer needs: replace the generation of what its change touched. It never throws. */
export interface Invalidator {
  invalidate(teamId: string, kinds: readonly CacheKind[]): Promise<void>;
}

export interface LoadOptions {
  /** True for a cache FILL: it must read the primary. False otherwise: the read-routing function decides (a replica, or the primary in the 5 s window). */
  primary: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  bypassed: number;
  off: number;
  errors: number;
  fillsSkipped: number;
  writesRejected: number;
  invalidations: number;
  invalidationFailures: number;
}

export interface GetInput<T> {
  kind: CacheKind;
  teamId: string;
  scope: Scope;
  /** Every other input that shapes the response, already validated and normalised (limit, a hash of the filters, a time range in epoch milliseconds...). */
  params: readonly string[];
  /** True during the user's 5 s read-your-own-writes window and the process's first 5 s: the cache is skipped entirely and not filled. */
  bypass: boolean;
  /** Reads the data. The value must be JSON-safe (it is stored as JSON and a hit returns the parsed JSON), so a Date is converted to its ISO string here. */
  load: (options: LoadOptions) => Promise<T>;
}

export interface TeamCache extends Invalidator {
  readonly enabled: boolean;
  get<T>(input: GetInput<T>): Promise<{ value: T; status: CacheStatus }>;
  stats(): CacheStats;
  /** Writes the `cache_stats` line for the window that just ended and starts a new one. */
  flushStats(): void;
  stop(): void;
}

export interface TeamCacheOptions {
  redis: CacheRedis;
  config: CacheConfig;
  logger?: Logger;
  now?: () => number;
  newGeneration?: () => string;
  /** How often the stats line is written. null: never (tests). */
  statsEveryMs?: number | null;
}

/**
 * After a Valkey failure, reads skip the cache for this long instead of each waiting out the connection's command timeout. CHOSEN, NOT MEASURED. Invalidations
 * are still attempted every time: a lost one leaves stale data for up to the entry TTL, so it is worth one bounded try.
 */
export const COOL_OFF_MS = 5_000;

const emptyStats = (): CacheStats => ({
  hits: 0,
  misses: 0,
  bypassed: 0,
  off: 0,
  errors: 0,
  fillsSkipped: 0,
  writesRejected: 0,
  invalidations: 0,
  invalidationFailures: 0,
});

/** Valkey's answer to a write it will not take because memory is full under `noeviction`: a reply that is an error, not a timeout. */
const isOom = (err: unknown): boolean => err instanceof Error && /^OOM\b/.test(err.message);

export function createTeamCache(options: TeamCacheOptions): TeamCache {
  const { redis, config, logger } = options;
  const now = options.now ?? Date.now;
  const newGeneration = options.newGeneration ?? randomUUID; // a random UUID, never a counter or a timestamp (caching.md)
  let counters = emptyStats();
  let windowStartedAt = now();

  // ---- outage bookkeeping: one log line per outage, one when it ends
  let down = false;
  let coolOffUntil = 0;
  function failed(err: unknown): void {
    coolOffUntil = now() + COOL_OFF_MS;
    if (!down) {
      down = true;
      logger?.error('cache_unavailable', { reason: sanitizeError(err) });
    }
    // A command that got no answer on a connection that still says "ready" is a half-open connection (issue #39): replace it.
    if (recycleIfStale(redis, err)) logger?.warn('cache_connection_recycled', { reason: 'no_reply_from_ready_connection' });
  }
  function succeeded(): void {
    if (down) {
      down = false;
      logger?.info('cache_recovered');
    }
  }

  // ---- the memory guard: stop FILLING (never reading) when Valkey is nearly full, so the cache cannot crowd out the queue (caching.md)
  let memoryOk = true;
  let nextMemoryCheckAt = 0;
  let blockedUntil = 0; // after Valkey itself refused a write (OOM)
  let memoryCheck: Promise<void> | null = null;
  let fillingStopped = false;
  async function refreshMemory(): Promise<void> {
    try {
      const info = await redis.info('memory');
      const used = Number(/^used_memory:(\d+)/m.exec(info)?.[1]);
      const max = Number(/^maxmemory:(\d+)/m.exec(info)?.[1]);
      if (!Number.isFinite(used) || !Number.isFinite(max)) throw new Error('INFO memory could not be read');
      // maxmemory 0 means no limit: there is nothing to measure against.
      memoryOk = max === 0 || (used / max) * 100 < config.memoryLimitPercent;
      succeeded();
    } catch (err) {
      memoryOk = false; // cannot tell, so do not add to Valkey
      failed(err);
    }
    nextMemoryCheckAt = now() + config.memoryCheckSeconds * 1000;
    if (!memoryOk && !fillingStopped) {
      fillingStopped = true;
      logger?.warn('cache_filling_stopped', { reason: 'memory_above_limit_or_unknown' });
    } else if (memoryOk && fillingStopped) {
      fillingStopped = false;
      logger?.info('cache_filling_resumed');
    }
  }
  async function mayFill(): Promise<boolean> {
    if (now() < blockedUntil) return false;
    if (now() >= nextMemoryCheckAt) {
      memoryCheck ??= refreshMemory().finally(() => {
        memoryCheck = null;
      });
      await memoryCheck;
    }
    return memoryOk && now() >= blockedUntil;
  }

  // ---- generations
  async function currentGeneration(teamId: string, kind: CacheKind): Promise<string> {
    const key = generationKey(teamId, kind);
    const existing = await redis.get(key);
    if (existing) return existing;
    // Created atomically and with an expiry. If another request created it first, NX leaves theirs alone and we read theirs back.
    await redis.set(key, newGeneration(), 'EX', config.generationTtlSeconds, 'NX');
    const created = await redis.get(key);
    if (!created) throw new Error('generation key missing right after it was created');
    return created;
  }

  async function fill(key: string, kind: CacheKind, value: unknown): Promise<void> {
    if (!(await mayFill())) {
      counters.fillsSkipped++;
      return;
    }
    try {
      // EX is always given: a key without a TTL is never written (caching.md).
      await redis.set(key, JSON.stringify(value), 'EX', config.ttlSeconds[kind]);
      succeeded();
    } catch (err) {
      if (isOom(err)) {
        counters.writesRejected++;
        blockedUntil = now() + config.memoryCheckSeconds * 1000;
        logger?.warn('cache_write_rejected', { reason: sanitizeError(err) });
      } else {
        failed(err);
      }
    }
  }

  async function get<T>(input: GetInput<T>): Promise<{ value: T; status: CacheStatus }> {
    const { kind, teamId, scope, params, bypass, load } = input;
    if (!config.enabled) {
      counters.off++;
      return { value: await load({ primary: false }), status: 'off' };
    }
    if (bypass) {
      // The user's own recent write, or a process that has only just started: never served from the cache and never fills it (caching.md).
      counters.bypassed++;
      return { value: await load({ primary: false }), status: 'bypass' };
    }
    if (now() < coolOffUntil) {
      counters.errors++;
      return { value: await load({ primary: false }), status: 'error' };
    }

    let key = '';
    try {
      const generation = await currentGeneration(teamId, kind); // BEFORE the database is read
      key = entryKey(teamId, kind, generation, scope, params);
      const raw = await redis.get(key);
      succeeded();
      if (raw !== null) {
        try {
          const value = JSON.parse(raw) as T;
          counters.hits++;
          return { value, status: 'hit' };
        } catch {
          // An entry that is not JSON is not an answer: treat it as a miss; the fill below replaces it.
        }
      }
    } catch (err) {
      failed(err);
      counters.errors++;
      return { value: await load({ primary: false }), status: 'error' };
    }

    counters.misses++;
    const value = await load({ primary: true }); // fills read the primary
    await fill(key, kind, value);
    return { value, status: 'miss' };
  }

  async function invalidate(teamId: string, kinds: readonly CacheKind[]): Promise<void> {
    if (!config.enabled) return; // the switch is off: nothing is written, not even this (caching.md test 10)
    try {
      // A new random UUID with an expiry. Called AFTER the writer's transaction committed, so a failure here can never undo or block the write.
      await Promise.all(kinds.map((kind) => redis.set(generationKey(teamId, kind), newGeneration(), 'EX', config.generationTtlSeconds)));
      counters.invalidations++;
      succeeded();
    } catch (err) {
      counters.invalidationFailures++;
      // Loud, because stale data can now be served for up to one entry TTL (the writer's own reads are protected by the 5 s window).
      logger?.error('cache_invalidation_failed', { reason: sanitizeError(err), teamId });
      if (!isOom(err)) failed(err);
    }
  }

  function flushStats(): void {
    const c = counters;
    const t = now();
    counters = emptyStats();
    const windowSeconds = Math.round((t - windowStartedAt) / 1000);
    windowStartedAt = t;
    const total = c.hits + c.misses + c.bypassed + c.off + c.errors + c.fillsSkipped + c.writesRejected + c.invalidations + c.invalidationFailures;
    if (total === 0) return; // a quiet minute writes nothing
    logger?.info('cache_stats', {
      windowSeconds,
      cacheHits: c.hits,
      cacheMisses: c.misses,
      cacheBypassed: c.bypassed,
      cacheOff: c.off,
      cacheErrors: c.errors,
      cacheFillsSkipped: c.fillsSkipped,
      cacheWritesRejected: c.writesRejected,
      cacheInvalidations: c.invalidations,
      cacheInvalidationFailures: c.invalidationFailures,
      // Of the reads that could have been served from the cache: how many were.
      ...(c.hits + c.misses > 0 ? { cacheHitRate: Math.round((c.hits / (c.hits + c.misses)) * 1000) / 1000 } : {}),
    });
  }

  const statsEveryMs = options.statsEveryMs === undefined ? 60_000 : options.statsEveryMs;
  const timer = statsEveryMs === null ? null : setInterval(flushStats, statsEveryMs);
  timer?.unref(); // never keeps the process alive

  return {
    enabled: config.enabled,
    get,
    invalidate,
    stats: () => ({ ...counters }),
    flushStats,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
