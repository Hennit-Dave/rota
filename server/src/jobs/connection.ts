import { Redis, type RedisOptions } from 'ioredis';
import {
  PRODUCER_COMMAND_TIMEOUT_MS,
  PRODUCER_CONNECT_TIMEOUT_MS,
  PRODUCER_MAX_RETRIES,
  VALKEY_KEEPALIVE_MS,
} from './config.js';

export function getValkeyUrl(): string {
  const url = process.env.VALKEY_URL;
  if (!url) {
    throw new Error('VALKEY_URL is not set.');
  }
  return url;
}

/**
 * Producer connection policy (enqueue path):
 * Strict timeouts, no offline queueing, limited retries so an unreachable Valkey cannot hang callers.
 *
 * Every producer connection the processes hold is long-lived (the rate limiter, the team cache, the API's queue, the worker's sweep
 * and cache), so each one gets the keep-alive below (ADR 0041). `keepAliveMs` exists for tests; production uses the default.
 */
export function createProducerConnection(url?: string, overrides?: RedisOptions, keepAliveMs: number = VALKEY_KEEPALIVE_MS): Redis {
  const connectionUrl = url ?? getValkeyUrl();
  const redis = new Redis(connectionUrl, {
    connectTimeout: PRODUCER_CONNECT_TIMEOUT_MS,
    commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES,
    enableOfflineQueue: false,
    lazyConnect: true,
    ...overrides,
  });
  startKeepAlive(redis, keepAliveMs);
  return redis;
}

/** The part of an ioredis connection the keep-alive needs. `ping` and `once` let unit tests pass a small fake. */
export type KeepAliveConnection = RecyclableConnection & {
  ping(): Promise<unknown>;
  once(event: 'close' | 'end', listener: () => void): unknown;
};

/**
 * Keep a long-lived connection from going idle (ADR 0041, issue #79).
 *
 * In plain words: Aiven closes a client connection that has sent nothing for `valkey_timeout` seconds. ioredis opens a new one at once,
 * so nothing fails outright, but every reopening is a `close` then a `ready`, and the worker's reconciliation sweep runs a full pass on
 * both shards after every one (ADR 0004). The sweep's connection is idle between sweeps, so it was closed and reopened all day, and
 * Neon never had the 5 idle minutes it needs to scale to zero (ADR 0040, incident).
 *
 * Every `intervalMs` a PING goes over a `ready` connection, so it is never idle for long. A connection that is not `ready` is left
 * alone: one that was never opened (`lazyConnect`) is not opened by this, and one that is reconnecting is ioredis's to handle. A PING
 * that gets no reply on a `ready` connection is the half-open case of issue #39, so it goes to `recycleIfStale`, which replaces the
 * connection. A PING answered with an error is not silence and changes nothing. Valkey only: nothing here touches Postgres.
 *
 * TCP keepalive (ioredis `keepAlive`) would not do this: Valkey's idle timer is reset by commands, and TCP keepalive probes never reach
 * Valkey as commands.
 *
 * Stops by itself when the connection ends for good (`quit()` or `disconnect()`), and when the returned function is called.
 */
export function startKeepAlive(redis: KeepAliveConnection, intervalMs: number = VALKEY_KEEPALIVE_MS): () => void {
  const timer = setInterval(() => {
    if (redis.status !== 'ready') return;
    redis.ping().catch((err: unknown) => {
      if (recycleIfStale(redis, err)) console.warn('[valkey:keepalive_recycled] reason=no_reply_to_ping');
    });
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  redis.once('end', stop);
  return stop;
}

/** A bounded Valkey call (the enqueue) ran out of its time budget. Treated like a command timeout (see recycleIfStale). */
export class EnqueueTimeoutError extends Error {
  constructor(ms: number) {
    super(`Valkey enqueue timed out after ${ms}ms`);
    this.name = 'EnqueueTimeoutError';
  }
}

/**
 * ioredis's own message for a command that got no reply within `commandTimeout`. It is a plain Error with this text; the
 * recovery test (valkey-recovery.integration.test.ts) fails if a library upgrade changes it.
 */
const COMMAND_TIMED_OUT = 'Command timed out';

/** True for "no answer at all" (a timeout), false for an answer that is an error (OOM under noeviction, a bad command...). */
export function isStaleConnectionSignal(err: unknown): boolean {
  return err instanceof EnqueueTimeoutError || (err instanceof Error && err.message === COMMAND_TIMED_OUT);
}

/** The part of an ioredis connection the recovery needs. `once` is optional so unit tests can pass a small fake. */
export type RecyclableConnection = {
  status: string;
  disconnect(reconnect?: boolean): void;
  once?(event: 'close', listener: () => void): unknown;
};

// Connections already being replaced, so a burst of timeouts starts one replacement, not one per request.
const recycling = new WeakSet<object>();

/**
 * Recover from a half-open connection (issue #39). A connection can die silently: the laptop sleeps, a NAT forgets the mapping,
 * the peer vanishes without a reset. No `close` or `error` ever arrives, so ioredis keeps calling it `ready`, every command
 * waits for a reply that never comes, and each one ends in `Command timed out` for ever. A clean drop (a reset, a server
 * restart) is different: ioredis sees it and reconnects by itself.
 *
 * A timeout on a connection that still says `ready` is the evidence, so the caller passes the failure here and the connection
 * is replaced: `disconnect(true)` closes the socket (ioredis destroys it after its own `disconnectTimeout` if the close never
 * completes, which is the half-open case) and reconnects with ioredis's own retry strategy. No new setting.
 *
 * It never makes a request succeed: the failing request still fails (fail closed, 503, security.md) and the next one finds a
 * live connection. A Valkey that is merely slow can cause a reconnect; that is accepted. A reply that is an error, such as OOM
 * under `noeviction`, is not a timeout and never triggers this. Returns true when it started a replacement.
 */
export function recycleIfStale(redis: RecyclableConnection | null | undefined, cause: unknown): boolean {
  if (!redis || !isStaleConnectionSignal(cause)) return false;
  if (redis.status !== 'ready' || recycling.has(redis)) return false;
  recycling.add(redis);
  redis.once?.('close', () => recycling.delete(redis));
  redis.disconnect(true);
  return true;
}

/**
 * Worker connection policy (consumer path):
 * maxRetriesPerRequest is null (required by BullMQ for blocking stream commands).
 */
export function createWorkerConnection(url?: string, overrides?: RedisOptions): Redis {
  const connectionUrl = url ?? getValkeyUrl();
  return new Redis(connectionUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    ...overrides,
  });
}

/**
 * Read-only verification of Valkey maxmemory-policy (jobs.md, ADR 0003), from INFO memory only: the
 * deploy credential's ACL denies CONFIG entirely (issue: deploy-only Valkey ACL user), and INFO memory
 * already reports maxmemory_policy, so CONFIG GET is never needed. Refuses startup if the policy cannot
 * be confirmed as 'noeviction'. Never changes the policy (never runs CONFIG SET; never ran it before either).
 */
export async function verifyNoEviction(redis: Redis): Promise<void> {
  const memoryInfo = await redis.info('memory');
  const match = memoryInfo.match(/^maxmemory_policy:([^\r\n]+)/m);
  const policy = match?.[1]?.trim() ?? null;

  if (policy !== 'noeviction') {
    throw new Error(
      `Valkey maxmemory-policy is '${policy ?? 'unknown'}'. Expected 'noeviction'. Startup refused.`
    );
  }
}
