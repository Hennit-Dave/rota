import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyNoEviction } from './connection.js';
import { enqueueWorkRow, formatJobId } from './queue.js';
import { createWorkProcessor, resolvePrismaClient } from './worker.js';

test('verifyNoEviction: verifies noeviction policy and rejects other policies', async () => {
  // Test 1: valid noeviction via INFO memory
  const mockValidRedis: any = {
    info: async () => 'some_info\r\nmaxmemory_policy:noeviction\r\nother_info',
  };
  await assert.doesNotReject(() => verifyNoEviction(mockValidRedis));

  // Test 2: invalid policy via INFO memory
  const mockInvalidRedis: any = {
    info: async () => 'some_info\r\nmaxmemory_policy:allkeys-lru\r\nother_info',
  };
  await assert.rejects(
    () => verifyNoEviction(mockInvalidRedis),
    /Expected 'noeviction'\. Startup refused\./,
  );

  // Test 3: fallback to CONFIG GET when INFO lacks maxmemory_policy
  const mockConfigFallback: any = {
    info: async () => 'no_policy_here',
    config: async () => ['maxmemory-policy', 'noeviction'],
  };
  await assert.doesNotReject(() => verifyNoEviction(mockConfigFallback));

  // Test 4: unverified policy throws
  const mockUnverified: any = {
    info: async () => 'empty',
    config: async () => {
      throw new Error('CONFIG GET disabled');
    },
  };
  await assert.rejects(
    () => verifyNoEviction(mockUnverified),
    /Expected 'noeviction'\. Startup refused\./,
  );
});

test('formatJobId: produces deterministic BullMQ custom ID without colons', () => {
  const rowId = 'd89c9417-3bf9-470d-b152-cbce9d846513';
  const jobId = formatJobId(rowId, 1);
  assert.equal(jobId, `work-${rowId}-1`);
  assert.ok(!jobId.includes(':'), 'BullMQ custom job IDs must not contain colons (jobs.md)');
});

test('enqueueWorkRow: validates shard identifier without database mutations', async () => {
  const mockPrisma: any = {};
  // Missing shard in options
  await assert.rejects(
    () => enqueueWorkRow(mockPrisma, 'test', {} as any),
    /Enqueue requires a valid shard \('A' \| 'B'\)/,
  );

  // Invalid shard in options
  await assert.rejects(
    () => enqueueWorkRow(mockPrisma, 'test', { shard: 'C' as any }),
    /Enqueue requires a valid shard \('A' \| 'B'\)/,
  );
});

test('createWorkProcessor: rejects missing or invalid shard in job payload', async () => {
  const processor = createWorkProcessor({} as any, {});

  // Missing shard
  const jobWithoutShard: any = { id: 'job-1', data: { rowId: 'row-1', generation: 1 } };
  await assert.rejects(
    () => processor(jobWithoutShard),
    /Job job-1 has invalid or missing shard identifier/,
  );

  // Invalid shard
  const jobWithInvalidShard: any = { id: 'job-2', data: { rowId: 'row-1', generation: 1, shard: 'Z' } };
  await assert.rejects(
    () => processor(jobWithInvalidShard),
    /Job job-2 has invalid or missing shard identifier: 'Z'/,
  );
});

test('resolvePrismaClient: correctly routes to shard A and B primaries', () => {
  const mockPrimaryA: any = { name: 'primary-A' };
  const mockPrimaryB: any = { name: 'primary-B' };
  const mockShards: any = {
    A: { primary: mockPrimaryA },
    B: { primary: mockPrimaryB },
  };

  assert.equal(resolvePrismaClient(mockShards, 'A'), mockPrimaryA);
  assert.equal(resolvePrismaClient(mockShards, 'B'), mockPrimaryB);

  // Single client fallback
  const mockSinglePrisma: any = { $queryRaw: async () => [] };
  assert.equal(resolvePrismaClient(mockSinglePrisma, 'A'), mockSinglePrisma);
  assert.equal(resolvePrismaClient(mockSinglePrisma, 'B'), mockSinglePrisma);
});
