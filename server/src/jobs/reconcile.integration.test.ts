import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { Queue, Worker } from 'bullmq';
import { createTestShards, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createProducerConnection, createWorkerConnection } from './connection.js';
import { createWorkQueue, enqueueWorkRow, formatJobId } from './queue.js';
import { reconcileOnce, reconcileShard } from './reconcile.js';
import { createWorkProcessor, renewClaimLease } from './worker.js';

let shards: Shards;
let prismaA: PrismaClient;
let prismaB: PrismaClient;

// Every test uses its own queue name on the shared Aiven instance and obliterates only that queue.
const cleanups: Array<() => Promise<void>> = [];

function newQueue(): Queue {
  const name = `test-reconcile-${randomUUID()}`;
  const conn = createProducerConnection();
  const queue = createWorkQueue(name, conn);
  cleanups.push(async () => {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    conn.disconnect();
  });
  return queue;
}

before(() => {
  shards = createTestShards({ primaryMax: 3 });
  prismaA = shards.A.primary;
  prismaB = shards.B.primary;
});

const created: Array<[PrismaClient, string]> = [];

function track<T extends { id: string }>(prisma: PrismaClient, row: T): T {
  created.push([prisma, row.id]);
  return row;
}

// A sweep scans every pending row on the shard, so rows must not outlive the test that made them.
async function deleteTracked() {
  for (const [p, id] of created.splice(0)) await p.workRow.deleteMany({ where: { id } });
}
afterEach(deleteTracked);

// One hook, in dependency order: rows, then queues, then the database clients.
after(async () => {
  await deleteTracked();
  for (const c of cleanups.reverse()) await c();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
});

async function makeRow(
  prisma: PrismaClient,
  data: Partial<{
    status: 'pending' | 'claimed' | 'done' | 'failed';
    generation: number;
    executionAttempts: number;
    recoveryCount: number;
    runAt: Date;
    availableAt: Date;
    claimToken: string | null;
    claimExpiresAt: Date | null;
  }> = {},
) {
  const row = await prisma.workRow.create({
    data: {
      kind: 'test-reconcile',
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
      runAt: new Date(Date.now() - 1000),
      availableAt: new Date(Date.now() - 1000),
      ...data,
    },
  });
  return track(prisma, row);
}

async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

const state = (q: Queue, id: string, gen: number) => q.getJobState(formatJobId(id, gen));

test('timed sweep restores a pending row whose job was never enqueued, and logs the delay', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaA);
  assert.equal(await state(queue, row.id, 1), 'unknown');

  const { value: result, lines } = await capture(() =>
    reconcileShard('A', prismaA, queue, { trigger: 'timed' }),
  );

  assert.ok(result.restored >= 1);
  assert.notEqual(await state(queue, row.id, 1), 'unknown', 'job must exist after the sweep');
  const log = lines.find((l) => l.includes(`row_id=${row.id}`) && l.includes('action=add'));
  assert.ok(log, 'sweep must log the restored row');
  assert.match(log, /trigger=timed .*generation=1 .*delay_ms=\d+/);

  const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.executionAttempts, 0);
  assert.equal(fresh.generation, 1);
});

test('timed sweep skips a pending row not yet past available_at; startup checks it anyway', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaA, { availableAt: new Date(Date.now() + 10 * 60_000) });

  await reconcileShard('A', prismaA, queue, { trigger: 'timed' });
  assert.equal(await state(queue, row.id, 1), 'unknown', 'timed sweep must not touch it yet');

  await reconcileShard('A', prismaA, queue, { trigger: 'startup' });
  assert.notEqual(await state(queue, row.id, 1), 'unknown', 'startup checks every pending row');
});

test('queue loss preserves the schedule: a lost delayed job comes back with its remaining delay', async () => {
  const queue = newQueue();
  const runAt = new Date(Date.now() + 60_000);
  const row = track(prismaA, await enqueueWorkRow(prismaA, 'test-reconcile', { shard: 'A', queue, runAt }));
  assert.equal(await state(queue, row.id, 1), 'delayed');

  const job = await queue.getJob(formatJobId(row.id, 1));
  await job!.remove(); // the job is lost; the row is not
  assert.equal(await state(queue, row.id, 1), 'unknown');

  await reconcileShard('A', prismaA, queue, { trigger: 'startup' });

  assert.equal(await state(queue, row.id, 1), 'delayed', 'restored as delayed, not waiting');
  const restored = await queue.getJob(formatJobId(row.id, 1));
  const remaining = runAt.getTime() - Date.now();
  assert.ok(restored!.opts.delay! <= 60_000, `delay ${restored!.opts.delay} must not exceed the original`);
  assert.ok(restored!.opts.delay! >= remaining - 1_000 && restored!.opts.delay! <= remaining + 5_000);

  const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.runAt.getTime(), runAt.getTime(), 'recovery never moves run_at');
  assert.equal(fresh.executionAttempts, 0, 'nothing ran early');
  assert.equal(fresh.status, 'pending');
});

test('a pending row with a live job is left alone', async () => {
  const queue = newQueue();
  const row = track(prismaA, await enqueueWorkRow(prismaA, 'test-reconcile', { shard: 'A', queue }));
  const before = await queue.getJob(formatJobId(row.id, 1));

  const { lines } = await capture(() => reconcileShard('A', prismaA, queue, { trigger: 'startup' }));

  const after = await queue.getJob(formatJobId(row.id, 1));
  assert.equal(after!.timestamp, before!.timestamp, 'same job, not re-added');
  assert.ok(lines.some((l) => l.includes(`row_id=${row.id}`) && l.includes('action=leave')));
});

test('enqueue failure makes the row eligible at once; the reconnect sweep enqueues it', async () => {
  const queue = newQueue();
  const broken: any = { add: async () => { throw new Error('OOM command not allowed when used memory > maxmemory'); } };
  const row = await capture(() => enqueueWorkRow(prismaA, 'test-reconcile', { shard: 'A', queue: broken, runAt: new Date() })).then((r) => r.value);
  track(prismaA, row);

  const stored = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(stored.status, 'pending');
  assert.ok(stored.availableAt.getTime() <= Date.now(), 'available_at = now() after a failed enqueue');
  assert.equal(await state(queue, row.id, 1), 'unknown');

  await reconcileShard('A', prismaA, queue, { trigger: 'reconnect' });
  assert.notEqual(await state(queue, row.id, 1), 'unknown');
});

test('expired claim with attempts left: new generation, claim cleared, attempts untouched, job added', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaB, {
    status: 'claimed',
    executionAttempts: 2,
    claimToken: randomUUID(),
    claimExpiresAt: new Date(Date.now() - 5_000),
  });

  await reconcileShard('B', prismaB, queue, { trigger: 'timed' });

  const fresh = await prismaB.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.generation, 2);
  assert.equal(fresh.executionAttempts, 2, 'recovery never resets or grants attempts');
  assert.equal(fresh.claimToken, null);
  assert.equal(fresh.claimExpiresAt, null);
  assert.ok(fresh.availableAt.getTime() > Date.now(), 'new job gets the 2 minute grace');
  assert.notEqual(await state(queue, row.id, 2), 'unknown', 'new generation job added');
  assert.equal(await state(queue, row.id, 1), 'unknown', 'old generation gets no job');
});

test('attempt budget holds across generations: expired claims end in failed at the max', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaA, {
    status: 'claimed',
    executionAttempts: 4,
    claimToken: randomUUID(),
    claimExpiresAt: new Date(Date.now() - 5_000),
  });

  await reconcileShard('A', prismaA, queue, { trigger: 'timed', maxAttempts: 5 });
  let fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.generation, 2);
  assert.equal(fresh.executionAttempts, 4);

  // Generation 2 claims (attempt 5) and the worker crashes again.
  await prismaA.workRow.update({
    where: { id: row.id },
    data: { status: 'claimed', executionAttempts: 5, claimToken: randomUUID(), claimExpiresAt: new Date(Date.now() - 1_000) },
  });
  await reconcileShard('A', prismaA, queue, { trigger: 'timed', maxAttempts: 5 });

  fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.failureReason, 'attempt_budget_exhausted');
  assert.equal(fresh.generation, 2, 'no further generation for a failed row');
  assert.equal(fresh.executionAttempts, 5);
  assert.equal(await state(queue, row.id, 3), 'unknown');
});

test('live lease, done and failed rows are never touched', async () => {
  const queue = newQueue();
  const live = await makeRow(prismaA, { status: 'claimed', executionAttempts: 1, claimToken: randomUUID(), claimExpiresAt: new Date(Date.now() + 60_000) });
  const done = await makeRow(prismaA, { status: 'done', executionAttempts: 1 });
  const failed = await makeRow(prismaA, { status: 'failed', executionAttempts: 5 });

  await reconcileShard('A', prismaA, queue, { trigger: 'startup' });

  for (const [r, status, gen] of [[live, 'claimed', 1], [done, 'done', 1], [failed, 'failed', 1]] as const) {
    const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(fresh.status, status);
    assert.equal(fresh.generation, gen);
    assert.equal(await state(queue, r.id, gen), 'unknown', 'no job added');
  }
});

test('stale execution is fenced: after the sweep bumps the generation, the old owner changes 0 rows', async () => {
  const queue = newQueue();
  const tokenA = randomUUID();
  const row = await makeRow(prismaA, {
    status: 'claimed',
    executionAttempts: 1,
    claimToken: tokenA,
    claimExpiresAt: new Date(Date.now() - 1_000),
  });

  await reconcileShard('A', prismaA, queue, { trigger: 'timed' });

  // Generation 2 is runnable once its grace window is over; B runs it to completion.
  await prismaA.workRow.update({ where: { id: row.id }, data: { availableAt: new Date() } });
  const processor = createWorkProcessor(shards, { 'test-reconcile': async () => {} });
  await processor({ id: formatJobId(row.id, 2), data: { rowId: row.id, generation: 2, shard: 'A' } } as any);

  const done = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(done.status, 'done');

  assert.equal(await renewClaimLease(prismaA, row.id, 1, tokenA), false, 'A cannot renew');
  const completed = await prismaA.$executeRaw`
    UPDATE work_rows SET status = 'done'::"work_status", updated_at = NOW()
    WHERE id = ${row.id}::uuid AND generation = 1 AND claim_token = ${tokenA}::uuid AND status = 'claimed'::"work_status"`;
  const failed = await prismaA.$executeRaw`
    UPDATE work_rows SET status = 'failed'::"work_status", updated_at = NOW()
    WHERE id = ${row.id}::uuid AND generation = 1 AND claim_token = ${tokenA}::uuid AND status = 'claimed'::"work_status"`;
  assert.equal(completed, 0);
  assert.equal(failed, 0);
  assert.equal((await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } })).status, 'done');
});

test('SKIP LOCKED: a row locked by another transaction is skipped, and the pass does not block on it', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaA);
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  let locked!: () => void;
  const isLocked = new Promise<void>((res) => (locked = res));

  const holder = prismaA.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM work_rows WHERE id = ${row.id}::uuid FOR UPDATE`;
    locked();
    await hold;
  });
  await isLocked;
  try {
    // The holder only releases after this block, so finishing at all means the pass did not wait on it.
    // (A time threshold would measure Neon latency, not blocking.)
    await Promise.race([
      reconcileShard('A', prismaA, queue, { trigger: 'startup' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('pass blocked on a locked row')), 30_000)),
    ]);
    assert.equal(await state(queue, row.id, 1), 'unknown', 'locked row skipped this pass');
  } finally {
    release();
    await holder;
  }
  await reconcileShard('A', prismaA, queue, { trigger: 'startup' });
  assert.notEqual(await state(queue, row.id, 1), 'unknown', 'picked up once unlocked');
});

test('batches page through every row, not just the first batch', async () => {
  const queue = newQueue();
  const rows = await Promise.all([1, 2, 3, 4, 5].map(() => makeRow(prismaA)));
  await reconcileShard('A', prismaA, queue, { trigger: 'startup', batchSize: 2 });
  for (const r of rows) {
    assert.notEqual(await state(queue, r.id, 1), 'unknown', `row ${r.id} must be restored`);
  }
});

test('Valkey failing on lookup ends the pass cleanly and leaves Postgres untouched', async () => {
  const row = await makeRow(prismaA);
  const brokenQueue: any = { getJobState: async () => { throw new Error('connect ECONNREFUSED rediss://default:pw@host:1'); } };

  const { value: result, lines } = await capture(() => reconcileShard('A', prismaA, brokenQueue, { trigger: 'timed' }));

  assert.equal(result.valkeyErrors, 1);
  assert.equal(result.postgresError, undefined);
  assert.ok(!lines.join('\n').includes('pw@'), 'connection string credentials are redacted');
  const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.generation, 1);
});

test('Valkey rejecting the add after a generation bump keeps the bump and makes the row eligible', async () => {
  const row = await makeRow(prismaB, {
    status: 'claimed',
    executionAttempts: 1,
    claimToken: randomUUID(),
    claimExpiresAt: new Date(Date.now() - 1_000),
  });
  const rejecting: any = { add: async () => { throw new Error('OOM command not allowed when used memory > maxmemory'); } };

  const result = await reconcileShard('B', prismaB, rejecting, { trigger: 'timed' });

  assert.equal(result.valkeyErrors, 1);
  const fresh = await prismaB.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.generation, 2, 'a Postgres change is never undone by a Valkey failure');
  assert.equal(fresh.executionAttempts, 1);
  assert.ok(fresh.availableAt.getTime() <= Date.now(), 'eligible for the next timed sweep');
});

test('a Postgres failure on one shard is reported and the other shard still runs', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaB);
  const brokenShards: any = {
    A: { primary: { $transaction: async () => { throw new Error('connection terminated postgresql://u:p@h/db'); } } },
    B: { primary: prismaB },
  };

  const { value: summary, lines } = await capture(() => reconcileOnce(brokenShards, queue, { trigger: 'startup' }));

  assert.match(summary.shards[0]!.postgresError ?? '', /connection terminated/);
  assert.ok(!lines.join('\n').includes('u:p@'), 'credentials redacted');
  assert.equal(summary.shards[1]!.postgresError, undefined);
  assert.notEqual(await state(queue, row.id, 1), 'unknown', 'shard B was still reconciled');
});

// --- Pre-claim failure guard (ADR 0004) ---

/**
 * Make BullMQ give up on this row's job at this generation without the row ever being claimed: the job is
 * replaced by one with a single attempt and a short-lived worker that throws before touching Postgres.
 */
async function failJobAt(queue: Queue, rowId: string, generation: number, reason = 'pre-claim failure') {
  const jobId = formatJobId(rowId, generation);
  await (await queue.getJob(jobId))?.remove();
  await queue.add('test-reconcile', { rowId, generation, shard: 'A' }, { jobId, attempts: 1 });
  const conn = createWorkerConnection();
  const worker = new Worker(queue.name, async () => { throw new Error(reason); }, { connection: conn });
  try {
    for (let i = 0; i < 100 && (await queue.getJobState(jobId)) !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await queue.getJobState(jobId), 'failed');
  } finally {
    await worker.close();
    conn.disconnect();
  }
}

test('a pending row whose job BullMQ failed gets a new generation; recovery_count rises, attempts carry over', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaA, { executionAttempts: 2 });
  await failJobAt(queue, row.id, 1);

  const { lines } = await capture(() =>
    reconcileShard('A', prismaA, queue, { trigger: 'startup', maxRecoveries: 5 }),
  );

  const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.generation, 2);
  assert.equal(fresh.recoveryCount, 1);
  assert.equal(fresh.executionAttempts, 2, 'recovery never resets or grants attempts');
  assert.notEqual(await state(queue, row.id, 2), 'unknown', 'new generation job added');
  assert.equal(await state(queue, row.id, 1), 'failed', 'old generation job left as it was');
  assert.ok(lines.some((l) => l.includes(`row_id=${row.id}`) && l.includes('action=new_generation') && l.includes('recoveries=1/5')));
});

test('a job that keeps failing before claim is NOT resurrected forever: the row ends failed at the cap', async () => {
  const queue = newQueue();
  const cap = 2;
  const row = await makeRow(prismaA);

  // Each round: BullMQ gives up on the current generation's job, then a sweep runs.
  for (let round = 1; round <= cap; round++) {
    await failJobAt(queue, row.id, round);
    await reconcileShard('A', prismaA, queue, { trigger: 'startup', maxRecoveries: cap });
    const mid = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(mid.status, 'pending');
    assert.equal(mid.generation, round + 1);
    assert.equal(mid.recoveryCount, round);
  }

  // One more failure at the cap: no new generation, the row is failed for a human.
  await failJobAt(queue, row.id, cap + 1, 'connect ECONNREFUSED postgresql://user:secret@host/db');
  const { value: result } = await capture(() =>
    reconcileShard('A', prismaA, queue, { trigger: 'startup', maxRecoveries: cap }),
  );

  assert.ok(result.unclaimable >= 1);
  const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.generation, cap + 1, 'no generation beyond the cap');
  assert.equal(fresh.executionAttempts, 0, 'never claimed');
  assert.match(fresh.failureReason ?? '', /^unclaimable_after_recoveries: /);
  assert.match(fresh.failureReason ?? '', /ECONNREFUSED/);
  assert.ok(!(fresh.failureReason ?? '').includes('secret'), 'credentials redacted in the stored reason');
  assert.equal(await state(queue, row.id, cap + 2), 'unknown', 'no job for a further generation');

  // A later sweep leaves the failed row alone: sweeps never retry failed rows.
  await reconcileShard('A', prismaA, queue, { trigger: 'startup', maxRecoveries: cap });
  assert.equal((await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } })).generation, cap + 1);
});

test('a successful claim resets recovery_count', async () => {
  const row = await makeRow(prismaA, { recoveryCount: 3 });
  const processor = createWorkProcessor(shards, { 'test-reconcile': async () => {} });

  await processor({ id: formatJobId(row.id, 1), data: { rowId: row.id, generation: 1, shard: 'A' } } as any);

  const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.status, 'done');
  assert.equal(fresh.recoveryCount, 0);
});

test('expired-claim recovery leaves recovery_count alone (attempts already bound it)', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaB, {
    status: 'claimed',
    executionAttempts: 1,
    recoveryCount: 0,
    claimToken: randomUUID(),
    claimExpiresAt: new Date(Date.now() - 1_000),
  });
  await reconcileShard('B', prismaB, queue, { trigger: 'timed' });
  const fresh = await prismaB.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.generation, 2);
  assert.equal(fresh.recoveryCount, 0);
});

test('Valkey rejecting the add after a failed-job bump keeps the bump and makes the row eligible', async () => {
  const queue = newQueue();
  const row = await makeRow(prismaA);
  await failJobAt(queue, row.id, 1);
  const real = queue.getJobState.bind(queue);
  const flaky: any = {
    getJobState: real,
    getJob: queue.getJob.bind(queue),
    add: async () => { throw new Error('OOM command not allowed when used memory > maxmemory'); },
  };

  const result = await reconcileShard('A', prismaA, flaky, { trigger: 'startup', maxRecoveries: 5 });

  assert.equal(result.valkeyErrors, 1);
  const fresh = await prismaA.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(fresh.generation, 2);
  assert.equal(fresh.recoveryCount, 1);
  assert.equal(fresh.status, 'pending');
  assert.ok(fresh.availableAt.getTime() <= Date.now(), 'eligible for the next timed sweep');
});
