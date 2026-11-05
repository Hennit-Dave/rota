import { Redis, type RedisOptions } from 'ioredis';
import {
  PRODUCER_COMMAND_TIMEOUT_MS,
  PRODUCER_CONNECT_TIMEOUT_MS,
  PRODUCER_MAX_RETRIES,
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
 */
export function createProducerConnection(url?: string, overrides?: RedisOptions): Redis {
  const connectionUrl = url ?? getValkeyUrl();
  return new Redis(connectionUrl, {
    connectTimeout: PRODUCER_CONNECT_TIMEOUT_MS,
    commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES,
    enableOfflineQueue: false,
    lazyConnect: true,
    ...overrides,
  });
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
