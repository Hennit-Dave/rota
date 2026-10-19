import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createShards } from '../../db/clients.js';
import { createProducerConnection, createWorkerConnection } from '../connection.js';
import { createWorkQueue, enqueueWorkRow } from '../queue.js';
import { createWorkWorker } from '../worker.js';

console.log('--- Proving Box 4 (Queue.add consumed by Worker) & Box 5 (Delayed job & retry) ---');

const shards = createShards({ primaryMax: 3 });
const prisma = shards.A.primary;
const queueConnection = createProducerConnection();
const workerConnection = createWorkerConnection();
const queueName = 'proof-boxes-4-5';
const queue = createWorkQueue(queueName, queueConnection);

let immediateDurationMs = 0;
let immediateCompleted = false;

let delayedFiredAt: number | null = null;
let delayedDueAt: number | null = null;
let delayedCompleted = false;

const retryTimestamps: number[] = [];
let retryCompleted = false;

const handlers = {
  'proof-immediate': async (ctx: any) => {
    const start = performance.now();
    // Simulate lightweight task (measuring actual handler execution duration)
    await prisma.workRow.update({
      where: { id: ctx.row.id },
      data: { failureReason: 'immediate-proof-executed' },
    });
    immediateDurationMs = performance.now() - start;
    console.log(`[Box 4] Immediate handler executed in ${immediateDurationMs.toFixed(2)}ms`);
    immediateCompleted = true;
  },
  'proof-delayed': async (ctx: any) => {
    delayedFiredAt = Date.now();
    console.log(`[Box 5A] Delayed job fired at ${new Date(delayedFiredAt).toISOString()}`);
    delayedCompleted = true;
  },
  'proof-retry': async (ctx: any) => {
    const now = Date.now();
    retryTimestamps.push(now);
    const attempt = retryTimestamps.length;
    console.log(`[Box 5B] Retry job attempt ${attempt} at ${new Date(now).toISOString()}`);
    if (attempt < 3) {
      throw new Error(`Transient failure on attempt ${attempt}`);
    }
    console.log('[Box 5B] Retry job succeeded on attempt 3');
    retryCompleted = true;
  },
};

const worker = createWorkWorker(prisma, handlers, {
  queueName,
  connection: workerConnection,
  leaseMs: 15_000,
  maxAttempts: 5,
});

try {
  // --- BOX 4: Immediate Job ---
  console.log('\nStarting Box 4: Enqueue immediate job...');
  const immRow = await enqueueWorkRow(prisma, 'proof-immediate', { queue });
  console.log(`Enqueued row ${immRow.id}`);

  const startWaitImm = Date.now();
  while (!immediateCompleted && Date.now() - startWaitImm < 15_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(immediateCompleted, true, 'Immediate job should have completed');

  const freshImm = await prisma.workRow.findUniqueOrThrow({ where: { id: immRow.id } });
  assert.equal(freshImm.status, 'done');
  assert.equal(freshImm.executionAttempts, 1);
  console.log(`Box 4 PROVEN: Row ${immRow.id} completed. Execution duration: ${immediateDurationMs.toFixed(2)}ms`);

  // --- BOX 5A: Delayed Job ---
  console.log('\nStarting Box 5A: Enqueue delayed job (delay 4000ms)...');
  const delayMs = 4000;
  const runAt = new Date(Date.now() + delayMs);
  delayedDueAt = runAt.getTime();
  const delRow = await enqueueWorkRow(prisma, 'proof-delayed', { queue, runAt });
  console.log(`Enqueued delayed row ${delRow.id} with run_at=${runAt.toISOString()}`);

  const startWaitDel = Date.now();
  while (!delayedCompleted && Date.now() - startWaitDel < 20_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(delayedCompleted, true, 'Delayed job should have completed');
  assert.ok(
    delayedFiredAt! >= delayedDueAt - 200,
    `Delayed job fired at ${delayedFiredAt}, before runAt ${delayedDueAt}`,
  );
  console.log(`Box 5A PROVEN: Job fired ${delayedFiredAt! - delayedDueAt}ms after due time`);

  // --- BOX 5B: Retry with Exponential Backoff ---
  console.log('\nStarting Box 5B: Enqueue retry job (fails twice, succeeds on attempt 3)...');
  const retRow = await enqueueWorkRow(prisma, 'proof-retry', { queue });
  console.log(`Enqueued retry row ${retRow.id}`);

  const startWaitRet = Date.now();
  while (!retryCompleted && Date.now() - startWaitRet < 25_000) {
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(retryCompleted, true, 'Retry job should have completed on attempt 3');
  assert.equal(retryTimestamps.length, 3);

  const delta1to2 = retryTimestamps[1]! - retryTimestamps[0]!;
  const delta2to3 = retryTimestamps[2]! - retryTimestamps[1]!;
  console.log(`Attempt 1 -> Attempt 2 delta: ${delta1to2}ms (expected ~2000ms base backoff)`);
  console.log(`Attempt 2 -> Attempt 3 delta: ${delta2to3}ms (expected ~4000ms exponential backoff)`);

  assert.ok(delta1to2 >= 1500, `Delta 1->2 was ${delta1to2}ms, expected >= 1500ms`);
  assert.ok(delta2to3 >= 3000, `Delta 2->3 was ${delta2to3}ms, expected >= 3000ms`);

  const freshRet = await prisma.workRow.findUniqueOrThrow({ where: { id: retRow.id } });
  assert.equal(freshRet.status, 'done');
  assert.equal(freshRet.executionAttempts, 3);
  console.log(`Box 5B PROVEN: Row ${retRow.id} completed after 3 attempts with exponential backoff`);

  // Cleanup created test rows
  await prisma.workRow.deleteMany({
    where: { id: { in: [immRow.id, delRow.id, retRow.id] } },
  });
} finally {
  await worker.close();
  await queue.close();
  await queueConnection.quit();
  await workerConnection.quit();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
}
