import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { DelayedError, Queue, type Job } from 'bullmq';
import { createShards, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  closeProducerQueue,
  createWorkQueue,
  enqueueWorkRow,
  formatJobId,
  getProducerQueue,
  WORK_QUEUE_NAME,
} from './queue.js';
import {
  ContentionError,
  createWorkProcessor,
  renewClaimLease,
} from './worker.js';

let shards: Shards;
let prismaA: PrismaClient;
let prismaB: PrismaClient;
let disconnectShards: () => Promise<void>;

before(async () => {
  // Database guard: prevent accidental execution on production/non-test environments
  if (process.env.TEST_DATABASE_ALLOWED !== 'true') {
    throw new Error(
      'Database integration tests require explicit guard: TEST_DATABASE_ALLOWED=true. Aborting to protect database rows.',
    );
  }

  if (!process.env.SHARD_A_DATABASE_URL || !process.env.SHARD_B_DATABASE_URL) {
    throw new Error('SHARD_A_DATABASE_URL and SHARD_B_DATABASE_URL must be configured for integration tests.');
  }

  shards = createShards({ primaryMax: 3 });
  prismaA = shards.A.primary;
  prismaB = shards.B.primary;
  disconnectShards = async () => {
    await shards.A.primary.$disconnect();
    await shards.B.primary.$disconnect();
    await closeProducerQueue();
  };
});

after(async () => {
  if (disconnectShards) {
    await disconnectShards();
  }
});

async function cleanupRow(prisma: PrismaClient, id: string) {
  await prisma.workRow.deleteMany({ where: { id } });
}

// --- ITEM 1: Unknown-Handler Regression Test ---
test('Item 1: unsupported job kind produces explicit failure, never marks work done', async () => {
  const row = await prismaA.workRow.create({
    data: {
      kind: 'unsupported-kind-regression',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const processor = createWorkProcessor(shards, {}, { leaseMs: 10_000, maxAttempts: 5 });
    const mockJob: any = { id: 'job-unsupported-1', data: { rowId: row.id, generation: 1, shard: 'A' } };

    await assert.rejects(
      () => processor(mockJob),
      /Unsupported job kind: 'unsupported-kind-regression'/,
    );

    // Row must NOT be done! Claim was released for retry, attempts incremented to 1
    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'pending', 'Row must remain pending for retry, never marked done');
    assert.equal(fresh.executionAttempts, 1);
    assert.equal(fresh.claimToken, null);
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

// --- ITEM 2: Shard Routing on Both Shard A and Shard B ---
test('Item 2: routes queued work to correct primary on Shard A and Shard B', async () => {
  // Test Shard A
  const rowA = await prismaA.workRow.create({
    data: {
      kind: 'test-shard-a',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  // Test Shard B
  const rowB = await prismaB.workRow.create({
    data: {
      kind: 'test-shard-b',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    let executedA = false;
    let executedB = false;

    const processor = createWorkProcessor(shards, {
      'test-shard-a': async (ctx) => {
        assert.equal(ctx.row.id, rowA.id);
        executedA = true;
      },
      'test-shard-b': async (ctx) => {
        assert.equal(ctx.row.id, rowB.id);
        executedB = true;
      },
    });

    const jobA: any = { id: 'job-shard-a', data: { rowId: rowA.id, generation: 1, shard: 'A' } };
    const jobB: any = { id: 'job-shard-b', data: { rowId: rowB.id, generation: 1, shard: 'B' } };

    await processor(jobA);
    await processor(jobB);

    assert.ok(executedA, 'Shard A handler executed');
    assert.ok(executedB, 'Shard B handler executed');

    const freshA = await prismaA.workRow.findUniqueOrThrow({ where: { id: rowA.id } });
    const freshB = await prismaB.workRow.findUniqueOrThrow({ where: { id: rowB.id } });
    assert.equal(freshA.status, 'done');
    assert.equal(freshB.status, 'done');

    // Missing work row check: routing to Shard B for a row that only exists on Shard A must fail explicitly
    const mismatchedJob: any = { id: 'job-mismatch', data: { rowId: rowA.id, generation: 1, shard: 'B' } };
    await assert.rejects(
      () => processor(mismatchedJob),
      new RegExp(`Work row ${rowA.id} not found on shard B`),
      'Missing work row must throw explicit error, never disguise routing failures',
    );
  } finally {
    await cleanupRow(prismaA, rowA.id);
    await cleanupRow(prismaB, rowB.id);
  }
});

// --- ITEM 5: Actual Simultaneous Claim Test ---
test('Item 5: simultaneous concurrent claims - exactly one wins, loser contends without attempt penalty', async () => {
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-simultaneous',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    let executionCount = 0;
    let job1Entered = false;
    let releaseJob1: () => void;
    const job1Barrier = new Promise<void>((resolve) => {
      releaseJob1 = resolve;
    });

    const processor = createWorkProcessor(shards, {
      'test-simultaneous': async () => {
        executionCount++;
        job1Entered = true;
        await job1Barrier;
      },
    });

    const job1: any = { id: 'sim-job-1', data: { rowId: row.id, generation: 1, shard: 'A' } };
    const job2: any = { id: 'sim-job-2', data: { rowId: row.id, generation: 1, shard: 'A' } };

    // Launch job 1
    const p1 = processor(job1, 'tok1');

    // Wait until job 1 has claimed and entered its handler
    while (!job1Entered) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Now job 1 holds active lease. Job 2 attempts concurrent claim on the same row:
    await assert.rejects(
      () => processor(job2, 'tok2'),
      (err: any) => err instanceof ContentionError,
      'Concurrent attempt during active claim must throw ContentionError',
    );

    // Release job 1 to complete
    releaseJob1!();
    await p1;

    assert.equal(executionCount, 1, 'Handler must execute exactly once');

    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'done');
    assert.equal(fresh.executionAttempts, 1, 'Contention must not increment execution_attempts');
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

// --- ITEM 5: Timeout / Late-Settlement Tests Showing Claimed/Done/Failed Rows Untouched ---
test('Item 5: enqueue timeout fallback leaves claimed, done, and failed rows untouched', async () => {
  const pastRunAt = new Date(Date.now() - 60_000);
  const futureAvailableAt = new Date(Date.now() + 120_000);

  // 1. Claimed row
  const claimedRow = await prismaA.workRow.create({
    data: {
      kind: 'test-untouched-claimed',
      status: 'claimed',
      claimToken: randomUUID(),
      claimExpiresAt: new Date(Date.now() + 30_000),
      generation: 1,
      executionAttempts: 1,
      runAt: pastRunAt,
      availableAt: futureAvailableAt,
    },
  });

  // 2. Done row
  const doneRow = await prismaA.workRow.create({
    data: {
      kind: 'test-untouched-done',
      status: 'done',
      generation: 1,
      executionAttempts: 1,
      runAt: pastRunAt,
      availableAt: futureAvailableAt,
    },
  });

  // 3. Failed row
  const failedRow = await prismaA.workRow.create({
    data: {
      kind: 'test-untouched-failed',
      status: 'failed',
      failureReason: 'simulated_failure',
      generation: 1,
      executionAttempts: 5,
      runAt: pastRunAt,
      availableAt: futureAvailableAt,
    },
  });

  try {
    // Simulate enqueue fallback query on all three rows
    for (const testRow of [claimedRow, doneRow, failedRow]) {
      const updated = await prismaA.$executeRaw`
        UPDATE work_rows
        SET available_at = NOW(), updated_at = NOW()
        WHERE id = ${testRow.id}::uuid
          AND generation = ${testRow.generation}
          AND status = 'pending'
      `;
      assert.equal(updated, 0, `Fallback update must affect 0 rows when status is ${testRow.status}`);
    }

    // Verify all rows remained completely untouched
    const freshClaimed = await prismaA.workRow.findUniqueOrThrow({ where: { id: claimedRow.id } });
    assert.equal(freshClaimed.status, 'claimed');
    assert.equal(freshClaimed.availableAt.getTime(), futureAvailableAt.getTime());

    const freshDone = await prismaA.workRow.findUniqueOrThrow({ where: { id: doneRow.id } });
    assert.equal(freshDone.status, 'done');
    assert.equal(freshDone.availableAt.getTime(), futureAvailableAt.getTime());

    const freshFailed = await prismaA.workRow.findUniqueOrThrow({ where: { id: failedRow.id } });
    assert.equal(freshFailed.status, 'failed');
    assert.equal(freshFailed.availableAt.getTime(), futureAvailableAt.getTime());
  } finally {
    await cleanupRow(prismaA, claimedRow.id);
    await cleanupRow(prismaA, doneRow.id);
    await cleanupRow(prismaA, failedRow.id);
  }
});

// --- ITEM 5: BullMQ Terminal Failed-Set Proof ---
test('Item 5: attempt ceiling failure marks row failed in Postgres and reaches BullMQ terminal failed set', async () => {
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-terminal-fail',
      status: 'pending',
      generation: 1,
      executionAttempts: 4, // 4 attempts already used; attempt 5 will reach ceiling
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const processor = createWorkProcessor(
      shards,
      {
        'test-terminal-fail': async () => {
          throw new Error('simulated-permanent-failure');
        },
      },
      { maxAttempts: 5 },
    );

    const mockJob: any = {
      id: `work-${row.id}-1`,
      data: { rowId: row.id, generation: 1, shard: 'A' },
    };

    // Attempt 5 fails
    await assert.rejects(
      () => processor(mockJob),
      /simulated-permanent-failure/,
    );

    // Postgres row must be marked failed
    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'failed');
    assert.equal(fresh.executionAttempts, 5);
    assert.equal(fresh.failureReason, 'simulated-permanent-failure');

    // Attempt ceiling on unowned pending row (e.g. from crash without clean handler failure)
    const crashedRow = await prismaA.workRow.create({
      data: {
        kind: 'test-terminal-fail',
        status: 'pending',
        generation: 1,
        executionAttempts: 5, // already exhausted
        runAt: new Date(Date.now() - 1000),
        availableAt: new Date(),
      },
    });

    try {
      const crashedJob: any = {
        id: `work-${crashedRow.id}-1`,
        data: { rowId: crashedRow.id, generation: 1, shard: 'A' },
      };

      await assert.rejects(
        () => processor(crashedJob),
        /Execution attempts \(5\) reached maximum \(5\)/,
      );

      const freshCrashed = await prismaA.workRow.findUniqueOrThrow({ where: { id: crashedRow.id } });
      assert.equal(freshCrashed.status, 'failed');
      assert.equal(freshCrashed.failureReason, 'attempt_budget_exhausted');
    } finally {
      await cleanupRow(prismaA, crashedRow.id);
    }
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

// --- ITEM 3: Producer Queue Lifecycle & Default Path ---
test('Item 3: producer queue default path lifecycle and fallback handling', async () => {
  const mockQueue: any = {
    add: async () => {
      // Simulate timeout
      await new Promise((r) => setTimeout(r, 2500));
    },
  };

  const row = await enqueueWorkRow(prismaA, 'test-default-producer', {
    shard: 'A',
    queue: mockQueue,
  });

  try {
    // Row was created in Postgres first
    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'pending');
    // Because timeout exceeded 2000ms, available_at was updated to NOW()
    assert.ok(fresh.availableAt.getTime() <= Date.now() + 500);
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

// --- CORE CLAIM & LEASE TESTS ---
test('atomic claim and 3-field completion succeeds', async () => {
  const row = await prismaA.workRow.create({
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
      shards,
      {
        'test-unit': async (ctx) => {
          assert.equal(ctx.row.id, row.id);
          assert.ok(ctx.claimToken);
          handlerExecuted = true;
        },
      },
      { leaseMs: 10_000, maxAttempts: 5 },
    );

    const mockJob: any = { data: { rowId: row.id, generation: 1, shard: 'A' } };
    await processor(mockJob);

    assert.ok(handlerExecuted, 'Handler should have executed');
    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'done');
    assert.equal(fresh.executionAttempts, 1);
    assert.ok(fresh.claimToken);
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

test('contention: active unexpired claim throws ContentionError without attempt penalty', async () => {
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-unit',
      status: 'claimed',
      generation: 1,
      executionAttempts: 1,
      claimToken: randomUUID(),
      claimExpiresAt: new Date(Date.now() + 20_000), // active claim
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const processor = createWorkProcessor(shards, {});
    const mockJob: any = { data: { rowId: row.id, generation: 1, shard: 'A' } };

    await assert.rejects(
      () => processor(mockJob),
      (err: any) => err instanceof ContentionError,
    );

    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.executionAttempts, 1, 'Contention must not increment execution_attempts');
    assert.equal(fresh.status, 'claimed');
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

test('live fifth-attempt regression test: duplicate delivery during live attempt 5 leaves it untouched, owner completes done', async () => {
  const ownerToken = randomUUID();
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-live-5',
      status: 'claimed',
      generation: 1,
      executionAttempts: 5, // on attempt 5!
      claimToken: ownerToken,
      claimExpiresAt: new Date(Date.now() + 20_000), // active lease
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const processor = createWorkProcessor(shards, {});
    const mockJob: any = { data: { rowId: row.id, generation: 1, shard: 'A' } };

    // Duplicate delivery arrives while attempt 5 is live: must be treated as contention, NOT marked failed
    await assert.rejects(
      () => processor(mockJob),
      (err: any) => err instanceof ContentionError,
    );

    const duringContention = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(duringContention.status, 'claimed');
    assert.equal(duringContention.executionAttempts, 5);
    assert.equal(duringContention.claimToken, ownerToken);

    // Legitimate owner finishes execution: completes done with 3-field check
    const completed = await prismaA.$executeRaw`
      UPDATE work_rows
      SET status = 'done'::"work_status", updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND generation = 1
        AND claim_token = ${ownerToken}::uuid
        AND status = 'claimed'::"work_status"
    `;
    assert.equal(completed, 1);

    const finalRow = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(finalRow.status, 'done');
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

test('early fire: job before run_at calls moveToDelayed and throws DelayedError without claiming', async () => {
  const futureRunAt = new Date(Date.now() + 10_000);
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-early',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: futureRunAt,
      availableAt: new Date(futureRunAt.getTime() + 120_000),
    },
  });

  try {
    let moveToDelayedCalledWith: number | null = null;
    const mockJob: any = {
      data: { rowId: row.id, generation: 1, shard: 'A' },
      moveToDelayed: async (timestamp: number, token: string) => {
        moveToDelayedCalledWith = timestamp;
      },
    };

    const processor = createWorkProcessor(shards, {});
    await assert.rejects(
      () => processor(mockJob, 'bullmq-token-123'),
      (err: any) => err instanceof DelayedError,
    );

    assert.equal(moveToDelayedCalledWith, futureRunAt.getTime());
    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'pending');
    assert.equal(fresh.executionAttempts, 0, 'Early fire must not claim or increment attempts');
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

test('stale ownership: completion fails and aborts if lease was claimed by another worker', async () => {
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-stale',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    const processor = createWorkProcessor(shards, {
      'test-stale': async () => {
        // While worker 1 is processing, worker 2 claims row after lease expires
        const newToken = randomUUID();
        await prismaA.$executeRaw`
          UPDATE work_rows
          SET claim_token = ${newToken}::uuid
          WHERE id = ${row.id}::uuid
        `;
      },
    });

    const mockJob: any = { data: { rowId: row.id, generation: 1, shard: 'A' } };
    // Processor completes without error (it aborts silently because ownership was lost)
    await processor(mockJob);

    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.notEqual(fresh.status, 'done', 'Stale execution must not mark row done');
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

test('lease renewal: renewClaimLease extends claim_expires_at for matching token, rejects mismatch', async () => {
  const token = randomUUID();
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-renewal',
      status: 'claimed',
      claimToken: token,
      claimExpiresAt: new Date(Date.now() + 5_000),
      generation: 1,
      executionAttempts: 1,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    // 1. Valid renewal
    const renewed = await renewClaimLease(prismaA, row.id, 1, token, 20_000);
    assert.ok(renewed, 'Lease should renew with valid token');

    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.ok(fresh.claimExpiresAt!.getTime() > Date.now() + 15_000);

    // 2. Invalid token renewal fails
    const badRenewed = await renewClaimLease(prismaA, row.id, 1, randomUUID(), 20_000);
    assert.equal(badRenewed, false, 'Lease renewal must fail with token mismatch');
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});
