import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createShards } from '../../db/clients.js';
import { createProducerConnection, createWorkerConnection } from '../connection.js';
import { createWorkQueue, enqueueWorkRow } from '../queue.js';
import { ContentionError, createWorkProcessor, createWorkWorker } from '../worker.js';

console.log('--- Proving Box 6 (Worker crash recovery with abrupt process termination) ---');

const queueName = `proof-crash-${Date.now()}`;
const leaseMs = 8_000; // 8 second lease for test observation

const shards = createShards({ primaryMax: 3 });
const prisma = shards.A.primary;
const queueConnection = createProducerConnection();
const queue = createWorkQueue(queueName, queueConnection);

try {
  // Step 1: Enqueue the crash test row
  const row = await enqueueWorkRow(prisma, 'proof-crash', { queue, shard: 'A' });
  console.log(`Enqueued crash test row ${row.id}`);

  // Step 2: Spawn child worker process directly via node
  console.log('Spawning child worker process...');
  const child = spawn(
    process.execPath,
    ['--env-file-if-exists=../.env', '--import', 'tsx', 'src/jobs/scripts/child-crash-worker.ts'],
    {
      env: {
        ...process.env,
        CRASH_QUEUE_NAME: queueName,
        CRASH_LEASE_MS: String(leaseMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let claimedAt = 0;

  child.stdout.on('data', (d) => {
    const text = d.toString();
    process.stdout.write(`  [child out] ${text}`);
    if (text.includes('[CHILD:CLAIMED]')) {
      claimedAt = Date.now();
    }
  });

  child.stderr.on('data', (d) => {
    process.stderr.write(`  [child err] ${d.toString()}`);
  });

  const childExitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  const exitInfo = await childExitPromise;
  const crashObservedAt = Date.now();
  console.log(`Child process terminated abruptly: exit code=${exitInfo.code}, signal=${exitInfo.signal}`);
  assert.ok(
    exitInfo.signal === 'SIGKILL' || exitInfo.code === 137,
    'Process must terminate via abrupt SIGKILL (code 137), not graceful shutdown',
  );

  // Step 3: Inspect Postgres state immediately after abrupt termination
  const postCrashRow = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
  console.log(`\nPostgres state immediately post-crash:`);
  console.log(`  status: ${postCrashRow.status}`);
  console.log(`  claimToken: ${postCrashRow.claimToken}`);
  console.log(`  claimExpiresAt: ${postCrashRow.claimExpiresAt?.toISOString()}`);
  console.log(`  executionAttempts: ${postCrashRow.executionAttempts}`);

  assert.equal(postCrashRow.status, 'claimed');
  assert.equal(postCrashRow.executionAttempts, 1);
  assert.ok(postCrashRow.claimExpiresAt);

  const remainingLeaseMs = postCrashRow.claimExpiresAt.getTime() - crashObservedAt;
  console.log(`Observed timing: Remaining Postgres lease at crash time = ${remainingLeaseMs}ms`);

  // Step 4: Controlled test of early-redelivery contention before lease expires (Requirement 2)
  console.log('\nTesting early-redelivery contention while Postgres lease is still active...');
  const earlyProcessor = createWorkProcessor(prisma, {}, { leaseMs, maxAttempts: 5 });
  const mockJob: any = { data: { rowId: row.id, generation: 1, shard: 'A' } };

  const earlyAttemptStart = Date.now();
  await assert.rejects(
    () => earlyProcessor(mockJob, 'token'),
    (err: any) => err instanceof ContentionError,
  );
  console.log(
    `Controlled early redelivery correctly threw ContentionError (${postCrashRow.claimExpiresAt.getTime() - earlyAttemptStart}ms before lease expiry). Attempts untouched.`,
  );

  // Verify attempts remained 1 during contention
  const contentionRow = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(contentionRow.executionAttempts, 1);

  // Step 5: Wait for lease expiry and observe recovery by restarted worker
  console.log('\nStarting restarted worker; waiting for Postgres lease expiry to reclaim...');
  const restartedConnection = createWorkerConnection();
  let recoveredDone = false;
  let restartedAttemptsObserved = 0;

  const restartedHandlers = {
    'proof-crash': async (ctx: any) => {
      if (ctx.row.id === row.id) {
        console.log(`[RESTARTED WORKER] successfully claimed row ${ctx.row.id}`);
        console.log(`  executionAttempts: ${ctx.row.executionAttempts}`);
        console.log(`  new claimToken: ${ctx.claimToken}`);
        restartedAttemptsObserved = ctx.row.executionAttempts;
      }
    },
  };

  const restartedWorker = createWorkWorker(shards, restartedHandlers, {
    queueName,
    connection: restartedConnection,
    leaseMs,
    maxAttempts: 5,
  });

  restartedWorker.on('completed', (j) => {
    if (j.data?.rowId === row.id) {
      recoveredDone = true;
    }
  });

  const startWaitRecover = Date.now();
  while (!recoveredDone && Date.now() - startWaitRecover < 35_000) {
    await new Promise((r) => setTimeout(r, 500));
  }

  assert.equal(recoveredDone, true, 'Restarted worker should have recovered and completed the job');
  assert.equal(restartedAttemptsObserved, 2, 'Execution attempts should have incremented to 2 upon reclaim');

  const finalRow = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
  console.log(`Final Postgres row status: ${finalRow.status}, executionAttempts: ${finalRow.executionAttempts}`);
  assert.equal(finalRow.status, 'done');
  assert.equal(finalRow.executionAttempts, 2);

  console.log('Box 6 PROVEN: Abrupt SIGKILL mid-claim recovered cleanly by restarted worker after lease expiry.');

  await restartedWorker.close();
  await restartedConnection.quit();
  await prisma.workRow.deleteMany({ where: { id: row.id } });
} finally {
  await queue.close();
  await queueConnection.quit();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
}
