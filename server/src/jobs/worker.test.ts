import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { DelayedError, type Job } from 'bullmq';
import { createShards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { verifyNoEviction } from './connection.js';
import { enqueueWorkRow } from './queue.js';
import {
  ContentionError,
  createWorkProcessor,
  renewClaimLease,
} from './worker.js';

let prisma: PrismaClient;
let disconnectShards: () => Promise<void>;

before(async () => {
  const shards = createShards({ primaryMax: 3 });
  prisma = shards.A.primary;
  disconnectShards = async () => {
    await shards.A.primary.$disconnect();
    await shards.B.primary.$disconnect();
  };
});

after(async () => {
  if (disconnectShards) {
    await disconnectShards();
  }
});

// Helper to clean up created test rows
async function cleanupRow(id: string) {
  await prisma.workRow.deleteMany({ where: { id } });
}

test('verifyNoEviction: verifies noeviction policy and rejects other policies', async () => {
  // Test 1: valid noeviction via INFO memory
  const mockValidRedis: any = {
    info: async (section: string) => `some_info\r\nmaxmemory_policy:noeviction\r\nother_info`,
  };
  await assert.doesNotReject(() => verifyNoEviction(mockValidRedis));

  // Test 2: invalid policy via INFO memory
  const mockInvalidRedis: any = {
    info: async (section: string) => `some_info\r\nmaxmemory_policy:allkeys-lru\r\nother_info`,
  };
  await assert.rejects(
    () => verifyNoEviction(mockInvalidRedis),
    /Expected 'noeviction'\. Startup refused\./,
  );

  // Test 3: fallback to CONFIG GET when INFO lacks maxmemory_policy
  const mockConfigFallback: any = {
    info: async () => 'no_policy_here',
    config: async (action: string, key: string) => ['maxmemory-policy', 'noeviction'],
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

test('atomic claim and 3-field completion succeeds', async () => {
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-unit',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    let handlerExecuted = false;
    const processor = createWorkProcessor(
      prisma,
      {
        'test-unit': async (ctx) => {
          assert.equal(ctx.row.id, row.id);
          assert.ok(ctx.claimToken);
          handlerExecuted = true;
        },
      },
      { leaseMs: 10_000, maxAttempts: 5 },
    );

    const mockJob: any = { data: { rowId: row.id, generation: 1 } };
    await processor(mockJob, 'bullmq-token');

    assert.equal(handlerExecuted, true);

    const updated = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(updated.status, 'done');
    assert.equal(updated.executionAttempts, 1);
  } finally {
    await cleanupRow(row.id);
  }
});

test('contention: active unexpired claim throws ContentionError without attempt penalty', async () => {
  const tokenA = randomUUID();
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-contention',
      status: 'claimed',
      generation: 1,
      claimToken: tokenA,
      claimExpiresAt: new Date(Date.now() + 20_000), // active for 20s
      executionAttempts: 1,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const processor = createWorkProcessor(prisma, {}, { leaseMs: 10_000, maxAttempts: 5 });
    const mockJob: any = { data: { rowId: row.id, generation: 1 } };

    await assert.rejects(
      () => processor(mockJob, 'token'),
      (err: any) => err instanceof ContentionError && /under active claim/.test(err.message),
    );

    // Verify row was NOT modified: still claimed by tokenA, attempts still 1
    const fresh = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'claimed');
    assert.equal(fresh.claimToken, tokenA);
    assert.equal(fresh.executionAttempts, 1);
  } finally {
    await cleanupRow(row.id);
  }
});

test('live fifth-attempt regression test: duplicate delivery during live attempt 5 leaves it untouched, owner completes done', async () => {
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-attempt-5',
      status: 'pending',
      generation: 1,
      executionAttempts: 4, // 4 attempts already executed
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    let ownerClaimToken = '';
    let duplicateChecked = false;

    // Worker processor
    const processor = createWorkProcessor(
      prisma,
      {
        'test-attempt-5': async (ctx) => {
          ownerClaimToken = ctx.claimToken;
          assert.equal(ctx.row.executionAttempts, 5);

          // Simulate duplicate delivery while attempt 5 is actively running!
          const duplicateJob: any = { data: { rowId: row.id, generation: 1 } };
          await assert.rejects(
            () => processor(duplicateJob, 'dup-token'),
            (err: any) => err instanceof ContentionError,
          );

          // Verify row is still claimed and NOT marked failed!
          const midFlight = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
          assert.equal(midFlight.status, 'claimed');
          assert.equal(midFlight.executionAttempts, 5);
          assert.equal(midFlight.claimToken, ownerClaimToken);

          duplicateChecked = true;
        },
      },
      { leaseMs: 15_000, maxAttempts: 5 },
    );

    const mockJob: any = { data: { rowId: row.id, generation: 1 } };
    await processor(mockJob, 'token-1');

    assert.equal(duplicateChecked, true);

    // Verify owner was able to complete the row as done!
    const finished = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finished.status, 'done');
    assert.equal(finished.executionAttempts, 5);
    assert.equal(finished.failureReason, null);
  } finally {
    await cleanupRow(row.id);
  }
});

test('attempt ceiling: failure on attempt 5 marks row failed, no 6th execution', async () => {
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-fail-5',
      status: 'pending',
      generation: 1,
      executionAttempts: 4,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const expectedError = new Error('simulated failure on 5th attempt');
    const processor = createWorkProcessor(
      prisma,
      {
        'test-fail-5': async () => {
          throw expectedError;
        },
      },
      { leaseMs: 10_000, maxAttempts: 5 },
    );

    const mockJob: any = { data: { rowId: row.id, generation: 1 } };

    // Attempt 5 runs and throws
    await assert.rejects(() => processor(mockJob, 'token-1'), /simulated failure/);

    // Verify row transitioned to status='failed'
    const failedRow = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(failedRow.status, 'failed');
    assert.equal(failedRow.executionAttempts, 5);
    assert.equal(failedRow.failureReason, 'simulated failure on 5th attempt');

    // Attempt 6 delivery: must exit cleanly without executing or modifying attempts
    let sixthRan = false;
    const processor6 = createWorkProcessor(
      prisma,
      {
        'test-fail-5': async () => {
          sixthRan = true;
        },
      },
      { leaseMs: 10_000, maxAttempts: 5 },
    );

    await processor6(mockJob, 'token-2');
    assert.equal(sixthRan, false);

    const finalRow = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, 'failed');
    assert.equal(finalRow.executionAttempts, 5);
  } finally {
    await cleanupRow(row.id);
  }
});

test('early fire: job before run_at calls moveToDelayed and throws DelayedError without claiming', async () => {
  const futureTime = new Date(Date.now() + 30_000);
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-early',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: futureTime,
      availableAt: new Date(futureTime.getTime() + 120_000),
    },
  });

  try {
    let moveToDelayedCalledWith: number | null = null;
    const mockJob: any = {
      data: { rowId: row.id, generation: 1 },
      moveToDelayed: async (time: number, token?: string) => {
        moveToDelayedCalledWith = time;
      },
    };

    const processor = createWorkProcessor(prisma, {}, { leaseMs: 10_000, maxAttempts: 5 });

    await assert.rejects(
      () => processor(mockJob, 'bullmq-token'),
      (err: any) => err instanceof DelayedError,
    );

    assert.equal(moveToDelayedCalledWith, futureTime.getTime());

    // Verify row is still pending with 0 attempts
    const fresh = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'pending');
    assert.equal(fresh.executionAttempts, 0);
  } finally {
    await cleanupRow(row.id);
  }
});

test('stale ownership: completion fails and aborts if lease was claimed by another worker', async () => {
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-stale-fencing',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const processor = createWorkProcessor(
      prisma,
      {
        'test-stale-fencing': async (ctx) => {
          // Stolen claim simulation: while this handler is running, another token steals the claim
          const tokenB = randomUUID();
          await prisma.$executeRaw`
            UPDATE work_rows
            SET claim_token = ${tokenB}::uuid,
                claim_expires_at = NOW() + interval '30 seconds',
                updated_at = NOW()
            WHERE id = ${row.id}::uuid
          `;
        },
      },
      { leaseMs: 5_000, maxAttempts: 5 },
    );

    const mockJob: any = { data: { rowId: row.id, generation: 1 } };
    await processor(mockJob, 'token');

    // Handler completed, but 3-field check matched 0 rows, so row remains claimed by tokenB and NOT done!
    const fresh = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'claimed');
  } finally {
    await cleanupRow(row.id);
  }
});

test('lease renewal: renewClaimLease extends claim_expires_at for matching token, rejects mismatch', async () => {
  const token = randomUUID();
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-renew',
      status: 'claimed',
      generation: 1,
      claimToken: token,
      claimExpiresAt: new Date(Date.now() + 5_000),
      executionAttempts: 1,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    // 1. Renewal with correct token and generation succeeds
    const renewed = await renewClaimLease(prisma, row.id, 1, token, 60_000);
    assert.equal(renewed, true);

    const fresh = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.ok(fresh.claimExpiresAt);
    assert.ok(fresh.claimExpiresAt.getTime() > Date.now() + 50_000);

    // 2. Renewal with wrong token fails (0 rows)
    const badTokenRenew = await renewClaimLease(prisma, row.id, 1, randomUUID(), 60_000);
    assert.equal(badTokenRenew, false);

    // 3. Renewal with wrong generation fails (0 rows)
    const badGenRenew = await renewClaimLease(prisma, row.id, 2, token, 60_000);
    assert.equal(badGenRenew, false);
  } finally {
    await cleanupRow(row.id);
  }
});

test('enqueueWorkRow: bounded timeout fallback updates available_at=NOW() while row is pending', async () => {
  // Mock a queue where add times out or rejects
  const mockTimeoutQueue: any = {
    add: async () => {
      // Simulate unreachable Valkey: promise that never resolves or rejects
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection refused')), 3000);
      });
    },
  };

  const row = await enqueueWorkRow(prisma, 'test-enqueue-timeout', {
    queue: mockTimeoutQueue,
  });

  try {
    // Normal initial creation would have availableAt = runAt + 2 minutes
    // But the 2-second timeout triggered the fallback:
    const fresh = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'pending');
    // availableAt was updated to approximately now (within 5 seconds)
    const diffMs = Math.abs(fresh.availableAt.getTime() - Date.now());
    assert.ok(diffMs < 5_000, `availableAt should be near now, was diff ${diffMs}ms`);
  } finally {
    await cleanupRow(row.id);
  }
});
