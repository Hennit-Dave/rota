import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { DelayedError, Queue, type Job } from 'bullmq';
import { createTestShards, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createProducerConnection, createWorkerConnection } from './connection.js';
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
  createWorkWorker,
  renewClaimLease,
} from './worker.js';

let shards: Shards;
let prismaA: PrismaClient;
let prismaB: PrismaClient;
let disconnectShards: () => Promise<void>;

before(async () => {
  shards = createTestShards({ primaryMax: 3 });
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

// --- ITEM 3: Simultaneous Claim Race Test (Reviewer Point 3) ---
test('Item 3: simultaneous claim race - launch both attempts before either completes, assert 1 winner and unchanged attempts for loser', async () => {
  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-simultaneous-race',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  try {
    let executionCount = 0;
    const processor = createWorkProcessor(shards, {
      'test-simultaneous-race': async () => {
        executionCount++;
        // Keep handler running briefly so both promises are concurrently active in flight
        await new Promise((r) => setTimeout(r, 100));
      },
    });

    const job1: any = { id: 'race-job-1', data: { rowId: row.id, generation: 1, shard: 'A' } };
    const job2: any = { id: 'race-job-2', data: { rowId: row.id, generation: 1, shard: 'A' } };

    // Launch BOTH before either has completed its claim or finished
    const p1 = processor(job1, 'tok1');
    const p2 = processor(job2, 'tok2');

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one claim attempt must win');
    assert.equal(rejected.length, 1, 'Exactly one claim attempt must lose');
    const loser = rejected[0];
    assert.ok(loser, 'Loser result must be present');
    assert.ok(
      loser.reason instanceof ContentionError,
      `Loser must throw ContentionError, got: ${loser.reason}`,
    );

    assert.equal(executionCount, 1, 'Handler must execute exactly once');

    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'done');
    assert.equal(fresh.executionAttempts, 1, 'Contention must not increment execution_attempts for the loser');
  } finally {
    await cleanupRow(prismaA, row.id);
  }
});

// --- ITEM 2: Producer Lifecycle & enqueueWorkRow Safety Tests (Reviewer Point 2) ---
test('Item 2A: producer queue default path lifecycle - reuse and shutdown', async () => {
  await closeProducerQueue();
  const testQueueName = `test-producer-lifecycle-${randomUUID()}`;

  // 1. Enqueue using the default producer queue singleton with explicit test queue name
  const row1 = await enqueueWorkRow(prismaA, 'test-producer-default', {
    shard: 'A',
    queueName: testQueueName,
  });
  try {
    const q1 = getProducerQueue(testQueueName);
    assert.ok(q1, 'getProducerQueue() should instantiate default queue');
    assert.equal(q1.name, testQueueName, 'Queue name must match isolated test queue');

    // 2. Second enqueue reuses the exact same queue instance
    const row2 = await enqueueWorkRow(prismaA, 'test-producer-default', {
      shard: 'A',
      queueName: testQueueName,
    });
    try {
      const q2 = getProducerQueue(testQueueName);
      assert.equal(q1, q2, 'Producer queue must be reused as singleton');

      const fresh1 = await prismaA.workRow.findUniqueOrThrow({ where: { id: row1.id } });
      const fresh2 = await prismaA.workRow.findUniqueOrThrow({ where: { id: row2.id } });
      assert.equal(fresh1.status, 'pending');
      assert.equal(fresh2.status, 'pending');
    } finally {
      await cleanupRow(prismaA, row2.id);
    }
  } finally {
    await cleanupRow(prismaA, row1.id);
    await closeProducerQueue();
  }
});

test('Item 2B: enqueueWorkRow itself for timeout/late-settlement safety - leaves claimed, done, and failed rows untouched', async () => {
  // Case A: Row transitions to claimed while queue.add hangs
  const slowQueueClaimed: any = {
    add: async (_name: string, payload: any) => {
      // Simulate concurrent worker claiming the row while enqueue is hanging
      await prismaA.workRow.update({
        where: { id: payload.rowId },
        data: {
          status: 'claimed',
          claimToken: randomUUID(),
          claimExpiresAt: new Date(Date.now() + 30_000),
        },
      });
      // Sleep past the 2000ms boundary so enqueueWorkRow times out
      await new Promise((r) => setTimeout(r, 2200));
    },
  };

  const rowA = await enqueueWorkRow(prismaA, 'test-late-claimed', {
    shard: 'A',
    queue: slowQueueClaimed,
  });

  try {
    // enqueueWorkRow caught the timeout and ran its internal fallback SQL
    const freshA = await prismaA.workRow.findUniqueOrThrow({ where: { id: rowA.id } });
    assert.equal(freshA.status, 'claimed', 'Status must remain claimed');
    assert.ok(
      freshA.availableAt.getTime() > Date.now() + 60_000,
      'available_at must remain untouched for claimed row',
    );
  } finally {
    await cleanupRow(prismaA, rowA.id);
  }

  // Case B: Row transitions to done while queue.add hangs
  const slowQueueDone: any = {
    add: async (_name: string, payload: any) => {
      await prismaA.workRow.update({
        where: { id: payload.rowId },
        data: { status: 'done' },
      });
      await new Promise((r) => setTimeout(r, 2200));
    },
  };

  const rowB = await enqueueWorkRow(prismaA, 'test-late-done', {
    shard: 'A',
    queue: slowQueueDone,
  });

  try {
    const freshB = await prismaA.workRow.findUniqueOrThrow({ where: { id: rowB.id } });
    assert.equal(freshB.status, 'done', 'Status must remain done');
    assert.ok(
      freshB.availableAt.getTime() > Date.now() + 60_000,
      'available_at must remain untouched for done row',
    );
  } finally {
    await cleanupRow(prismaA, rowB.id);
  }

  // Case C: Row transitions to failed while queue.add hangs
  const slowQueueFailed: any = {
    add: async (_name: string, payload: any) => {
      await prismaA.workRow.update({
        where: { id: payload.rowId },
        data: { status: 'failed', failureReason: 'simulated_terminal_failure' },
      });
      await new Promise((r) => setTimeout(r, 2200));
    },
  };

  const rowC = await enqueueWorkRow(prismaA, 'test-late-failed', {
    shard: 'A',
    queue: slowQueueFailed,
  });

  try {
    const freshC = await prismaA.workRow.findUniqueOrThrow({ where: { id: rowC.id } });
    assert.equal(freshC.status, 'failed', 'Status must remain failed');
    assert.ok(
      freshC.availableAt.getTime() > Date.now() + 60_000,
      'available_at must remain untouched for failed row',
    );
  } finally {
    await cleanupRow(prismaA, rowC.id);
  }
});

// --- ITEM 1: Real BullMQ Worker Terminal Failed Set Proof (Reviewer Point 1) ---
test('Item 1: attempt ceiling failure - real BullMQ worker moves job to terminal failed set and marks Postgres row failed', async () => {
  const testQueueName = `test-terminal-fail-${randomUUID()}`;
  const testQueueConn = createProducerConnection();
  const testWorkerConn = createWorkerConnection();
  const testQueue = createWorkQueue(testQueueName, testQueueConn);

  const row = await prismaA.workRow.create({
    data: {
      kind: 'test-real-terminal-fail',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(),
    },
  });

  let worker: ReturnType<typeof createWorkWorker> | null = null;

  try {
    const failedPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for real BullMQ terminal failure'));
      }, 15_000);
      timeout.unref?.();

      worker = createWorkWorker(
        shards,
        {
          'test-real-terminal-fail': async () => {
            throw new Error('permanent-terminal-failure');
          },
        },
        {
          queueName: testQueueName,
          connection: testWorkerConn,
          maxAttempts: 1, // terminal ceiling reached on 1st attempt
          leaseMs: 10_000,
        },
      );

      worker.on('failed', (job) => {
        if (job?.data?.rowId === row.id) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Enqueue directly to the test queue with attempts: 1 to ensure BullMQ treats attempt 1 as terminal
    await testQueue.add(
      'test-real-terminal-fail',
      { rowId: row.id, generation: 1, shard: 'A' },
      { jobId: formatJobId(row.id, 1), attempts: 1 },
    );

    await failedPromise;

    // 1. Inspect actual BullMQ terminal failed set
    const failedJobs = await testQueue.getFailed();
    const bullmqJob = failedJobs.find((j) => j.id === formatJobId(row.id, 1));
    assert.ok(bullmqJob, 'Job must be present in BullMQ terminal failed set');
    assert.equal(bullmqJob.attemptsMade, 1);
    assert.match(bullmqJob.failedReason ?? '', /permanent-terminal-failure/);

    // 2. Inspect Postgres row state
    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(fresh.status, 'failed', 'Postgres row must be marked failed');
    assert.equal(fresh.executionAttempts, 1);
    assert.match(fresh.failureReason ?? '', /permanent-terminal-failure/);
  } finally {
    if (worker) {
      await (worker as any).close();
    }
    await testQueue.close();
    await testQueueConn.quit();
    await testWorkerConn.quit();
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
