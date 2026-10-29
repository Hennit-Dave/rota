import { createShards, createTestShards, type PoolConfig, type Shards } from './clients.js';

/**
 * The shards the API and the worker run against.
 *
 * `USE_TEST_SHARDS=true` points them at the TEST shards (TEST_SHARD_*_DATABASE_URL, behind the TEST_DATABASE_ALLOWED guard), never at the real ones. Every
 * PROOF run (evidence for a PR, a demo of a slice, a manual end-to-end with Stripe) uses it through `npm run proof:api` and `npm run proof:worker`. The real
 * shards are used only with Dave's explicit go, and the PR says so (AGENTS.md, evidence-capture.md). Without the variable nothing changes: the real shards.
 */
export function createRuntimeShards(pool: PoolConfig, label: string): Shards {
  if (process.env.USE_TEST_SHARDS === 'true') {
    const shards = createTestShards(pool);
    console.log(`${label}: running against the TEST shards (USE_TEST_SHARDS=true)`);
    return shards;
  }
  console.log(`${label}: running against the REAL shards`);
  return createShards(pool);
}
