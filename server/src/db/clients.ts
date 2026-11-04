import { PrismaPg } from '@prisma/adapter-pg';
import { readReplicas } from '@prisma/extension-read-replicas';
import { PrismaClient } from '../generated/prisma/client.js';
import { shardFor, type ShardId } from './shard.js';

// Runtime clients use the POOLED (-pooler) URLs. They never fall back to the direct URLs: if the pooled
// connection fails, the failure is reported (data.md, ADR 0002).
const POOLED_VAR: Record<ShardId, string> = {
  A: 'SHARD_A_DATABASE_URL',
  B: 'SHARD_B_DATABASE_URL',
};

// The replica's pooled (-pooler) URL, one per shard (ADR 0037). Same role and database as the primary; only the host differs.
const READ_VAR: Record<ShardId, string> = {
  A: 'SHARD_A_READ_URL',
  B: 'SHARD_B_READ_URL',
};

/**
 * How long a connection to the replica may take before the attempt fails. A replica that scaled to zero wakes on the first query
 * (measured 1.4 to 2.5 s once); 8 s leaves room for that and still gives up before a caller waits too long. CHOSEN, NOT MEASURED.
 * A failed attempt is not an error for the caller: the read falls back to the primary (readRouting.ts).
 */
export const REPLICA_CONNECT_TIMEOUT_MS = 8_000;

/** The primary client extended with `$replica()` over a replica client. Used ONLY by the read-routing function (readRouting.ts). */
function withReplica(primary: PrismaClient, replica: PrismaClient) {
  return primary.$extends(readReplicas({ replicas: [replica] }));
}
export type ReaderClient = ReturnType<typeof withReplica>;

export type ShardClients = {
  /**
   * Primary client for this shard: the PLAIN client, so every read made on it goes to the primary, as it always has. Extending a client would
   * send its plain model reads (`findMany`, `findFirst`, ...) to the replica, which would silently move every auth, billing and permission read.
   */
  primary: PrismaClient;
  /** The extended client, present only in a process that asked for replicas (the API). Reached only through the read-routing function. */
  reader?: ReaderClient;
};

export type PoolConfig = {
  /** Pool maximum per shard primary. data.md: API 5, worker 3. */
  primaryMax: number;
  /** Pool maximum per shard replica. Given only by the API (data.md: 5); the worker uses primary clients only and leaves it out. */
  replicaMax?: number;
  /** Tests and proofs only: the replica client emits a Prisma `query` event per query, so a test can see exactly what the replica was asked. */
  logReplicaQueries?: boolean;
};

export function createShardClients(shard: ShardId, pool: PoolConfig, connectionStringOverride?: string, readStringOverride?: string): ShardClients {
  const varName = POOLED_VAR[shard];
  const connectionString = connectionStringOverride ?? process.env[varName];
  if (!connectionString) throw new Error(`${varName} is not set.`);
  const primary = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: pool.primaryMax }) });
  if (pool.replicaMax === undefined) return { primary };

  const readVar = READ_VAR[shard];
  const readString = readStringOverride ?? process.env[readVar];
  if (!readString) throw new Error(`${readVar} is not set.`);
  const replica = new PrismaClient({
    adapter: new PrismaPg({ connectionString: readString, max: pool.replicaMax, connectionTimeoutMillis: REPLICA_CONNECT_TIMEOUT_MS }),
    ...(pool.logReplicaQueries ? { log: [{ emit: 'event' as const, level: 'query' as const }] } : {}),
  });
  return { primary, reader: withReplica(primary, replica) };
}

export type Shards = Record<ShardId, ShardClients>;

export function createShards(pool: PoolConfig, overrides?: Partial<Record<ShardId, string>>, readOverrides?: Partial<Record<ShardId, string>>): Shards {
  return {
    A: createShardClients('A', pool, overrides?.A, readOverrides?.A),
    B: createShardClients('B', pool, overrides?.B, readOverrides?.B),
  };
}

/** Closes every pool of every shard: the primaries and, where there are any, the replicas. */
export async function closeShards(shards: Shards): Promise<void> {
  for (const id of ['A', 'B'] as const) {
    await shards[id].primary.$disconnect();
    await shards[id].reader?.$disconnect();
  }
}

/**
 * Creates shards strictly from TEST_SHARD_A_DATABASE_URL and TEST_SHARD_B_DATABASE_URL.
 * Enforces TEST_DATABASE_ALLOWED=true and never falls back to ordinary application shard URLs.
 */
export function createTestShards(pool: PoolConfig): Shards {
  if (process.env.TEST_DATABASE_ALLOWED !== 'true') {
    throw new Error(
      'Database tests and proofs require explicit guard: TEST_DATABASE_ALLOWED=true. Aborting to protect database rows.',
    );
  }

  const testShardA = process.env.TEST_SHARD_A_DATABASE_URL;
  const testShardB = process.env.TEST_SHARD_B_DATABASE_URL;

  if (!testShardA || !testShardB) {
    throw new Error(
      'Database tests and proofs require TEST_SHARD_A_DATABASE_URL and TEST_SHARD_B_DATABASE_URL to be set explicitly. ' +
      'Ordinary application shard URLs (SHARD_A_DATABASE_URL, SHARD_B_DATABASE_URL) will not be used as fallback.',
    );
  }

  // Replicas only when the caller asked for them (pool.replicaMax). Their URLs are explicit too, with no fallback to the real shards' read URLs.
  const reads: Partial<Record<ShardId, string>> = {};
  if (pool.replicaMax !== undefined) {
    const readA = process.env.TEST_SHARD_A_READ_URL;
    const readB = process.env.TEST_SHARD_B_READ_URL;
    if (!readA || !readB) {
      throw new Error(
        'Replica reads in tests and proofs require TEST_SHARD_A_READ_URL and TEST_SHARD_B_READ_URL to be set explicitly. ' +
        'The real shards\' read URLs (SHARD_A_READ_URL, SHARD_B_READ_URL) will not be used as fallback.',
      );
    }
    reads.A = readA;
    reads.B = readB;
  }
  return createShards(pool, { A: testShardA, B: testShardB }, reads);
}

/**
 * The only way to reach a team's shard. Never import a shard's client directly (data.md).
 */
export function getShard(shards: Shards, teamId: string): ShardClients {
  return shards[shardFor(teamId)];
}
