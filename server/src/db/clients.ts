import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { shardFor, type ShardId } from './shard.js';

// Runtime clients use the POOLED (-pooler) URLs. They never fall back to the direct URLs: if the pooled
// connection fails, the failure is reported (data.md, ADR 0002).
const POOLED_VAR: Record<ShardId, string> = {
  A: 'SHARD_A_DATABASE_URL',
  B: 'SHARD_B_DATABASE_URL',
};

export type ShardClients = {
  /** Primary client for this shard. Replica clients arrive with read routing (build-order step 5). */
  primary: PrismaClient;
};

export type PoolConfig = {
  /** Pool maximum per shard primary. data.md: API 5, worker 3. */
  primaryMax: number;
};

export function createShardClients(shard: ShardId, pool: PoolConfig, connectionStringOverride?: string): ShardClients {
  const varName = POOLED_VAR[shard];
  const connectionString = connectionStringOverride ?? process.env[varName];
  if (!connectionString) throw new Error(`${varName} is not set.`);
  const adapter = new PrismaPg({ connectionString, max: pool.primaryMax });
  return { primary: new PrismaClient({ adapter }) };
}

export type Shards = Record<ShardId, ShardClients>;

export function createShards(pool: PoolConfig, overrides?: Partial<Record<ShardId, string>>): Shards {
  return {
    A: createShardClients('A', pool, overrides?.A),
    B: createShardClients('B', pool, overrides?.B),
  };
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

  return createShards(pool, { A: testShardA, B: testShardB });
}

/**
 * The only way to reach a team's shard. Never import a shard's client directly (data.md).
 */
export function getShard(shards: Shards, teamId: string): ShardClients {
  return shards[shardFor(teamId)];
}
