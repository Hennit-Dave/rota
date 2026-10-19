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
 * Read-only verification of Valkey maxmemory-policy (jobs.md, ADR 0003).
 * Reads INFO memory, with fallback to CONFIG GET maxmemory-policy.
 * Refuses startup if the policy cannot be confirmed as 'noeviction'.
 * Never changes the policy (never runs CONFIG SET).
 */
export async function verifyNoEviction(redis: Redis): Promise<void> {
  let policy: string | null = null;

  try {
    const memoryInfo = await redis.info('memory');
    const match = memoryInfo.match(/^maxmemory_policy:([^\r\n]+)/m);
    if (match && match[1]) {
      policy = match[1].trim();
    }
  } catch {
    // If INFO memory fails, try CONFIG GET below
  }

  if (!policy) {
    try {
      const configRes = await redis.config('GET', 'maxmemory-policy');
      if (Array.isArray(configRes) && configRes.length >= 2) {
        policy = configRes[1];
      } else if (configRes && typeof configRes === 'object') {
        policy = (configRes as Record<string, string>)['maxmemory-policy'] ?? null;
      }
    } catch {
      // Permission denied or command restricted
    }
  }

  if (policy !== 'noeviction') {
    throw new Error(
      `Valkey maxmemory-policy is '${policy ?? 'unknown'}'. Expected 'noeviction'. Startup refused.`
    );
  }
}
