import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import type { Queue } from 'bullmq';
import { createTestShards, type Shards } from '../db/clients.js';
import { createEmailHandler } from './email.js';
import { cleanupEmails, FakeResend, makeInviteEmail } from './email.testkit.js';
import { createProducerConnection } from './connection.js';
import { addWorkJob, createWorkQueue, enqueueCommittedRow, formatJobId } from './queue.js';
import { reconcileOnce } from './reconcile.js';
import { createWorkProcessor } from './worker.js';

// A real queue per test on the shared Aiven Valkey, under its own name; only that queue is obliterated (jobs.md: never touch the shared keys).
const cleanups: Array<() => Promise<void>> = [];
function newQueue(): Queue {
  const conn = createProducerConnection();
  const queue = createWorkQueue(`test-email-recovery-${randomUUID()}`, conn);
  cleanups.push(async () => {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    conn.disconnect();
  });
  return queue;
}

let shards: Shards;
before(() => {
  shards = createTestShards({ primaryMax: 3 });
});
afterEach(cleanupEmails);
after(async () => {
  await cleanupEmails();
  for (const c of cleanups.reverse()) await c();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
});

const stateOf = (q: Queue, id: string, gen = 1) => q.getJobState(formatJobId(id, gen));

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

test('a LOST invite email on shard B: the queued job is deleted from Valkey, the sweep restores it from Postgres, and it is then sent exactly once with the stored payload', async () => {
  const queue = newQueue();
  const made = await makeInviteEmail(shards, 'B');
  const prisma = shards.B.primary;
  const row = await prisma.workRow.findUniqueOrThrow({ where: { id: made.workRowId } });

  await addWorkJob(queue, row, 'B');
  assert.notEqual(await stateOf(queue, row.id), 'unknown');
  await (await queue.getJob(formatJobId(row.id, 1)))!.remove(); // Valkey loses the job; Postgres still has the row
  assert.equal(await stateOf(queue, row.id), 'unknown');

  const swept = await capture(() => reconcileOnce(shards, queue, { trigger: 'timed' }));
  assert.ok(
    swept.lines.some((l) => l.includes('trigger=timed') && l.includes('shard=B') && l.includes(`row_id=${row.id}`) && l.includes('action=add') && l.includes('reason=job_missing')),
    `the sweep logged the restore on shard B:\n${swept.lines.filter((l) => l.includes(row.id)).join('\n')}`,
  );
  assert.ok(['waiting', 'delayed', 'active'].includes(await stateOf(queue, row.id)), 'the job is back in the queue');
  assert.equal((await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } })).executionAttempts, 0, 'nothing ran by itself');

  // The restored job carries the shard, and the real processor sends the stored payload once.
  const restored = await queue.getJob(formatJobId(row.id, 1));
  assert.deepEqual(restored!.data, { rowId: row.id, generation: 1, shard: 'B' });
  const resend = new FakeResend();
  await createWorkProcessor(shards, { email: createEmailHandler({ resend }) }, { leaseMs: 10_000 })(restored!);
  const done = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(done.status, 'done');
  assert.ok(done.sentAt);
  assert.equal(resend.deliveries, 1);
  assert.equal(resend.calls[0]!.key, `email-${row.id}`);
  assert.equal(resend.calls[0]!.payload.to[0], made.to);
});

test('an enqueue that failed after the invitation committed (Valkey down): the row is eligible at once and the next sweep enqueues it, on shard B', async () => {
  const queue = newQueue();
  const made = await makeInviteEmail(shards, 'B', { runAt: new Date(), availableAt: new Date(Date.now() + 120_000) }); // normal creation: available 2 minutes out
  const prisma = shards.B.primary;
  const row = await prisma.workRow.findUniqueOrThrow({ where: { id: made.workRowId } });

  const outcome = await capture(() =>
    enqueueCommittedRow(prisma, row, 'B', () => {
      throw new Error('simulated valkey failure');
    }),
  );
  assert.equal(outcome.value.enqueued, false, 'the failure is swallowed: the request would still have succeeded');
  const eligible = await prisma.workRow.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(eligible.availableAt.getTime() <= Date.now() + 1000, 'available_at = now()');
  assert.equal(eligible.status, 'pending');
  assert.equal(await stateOf(queue, row.id), 'unknown');

  await capture(() => reconcileOnce(shards, queue, { trigger: 'timed' }));
  assert.ok(['waiting', 'delayed', 'active'].includes(await stateOf(queue, row.id)), 'the sweep put it in the queue');
});

test('a sweep that restores a job does not move run_at, resets nothing, and an email already sent is left alone', async () => {
  const queue = newQueue();
  const made = await makeInviteEmail(shards, 'A');
  const prisma = shards.A.primary;
  await prisma.$executeRaw`UPDATE work_rows SET sent_at = NOW(), status = 'done'::"work_status", first_attempt_at = NOW() - interval '1 hour' WHERE id = ${made.workRowId}::uuid`;
  const before = await prisma.workRow.findUniqueOrThrow({ where: { id: made.workRowId } });
  await capture(() => reconcileOnce(shards, queue, { trigger: 'timed' }));
  assert.equal(await stateOf(queue, made.workRowId), 'unknown', 'a done row gets no job');
  const after = await prisma.workRow.findUniqueOrThrow({ where: { id: made.workRowId } });
  assert.equal(after.runAt.getTime(), before.runAt.getTime());
  assert.equal(after.firstAttemptAt!.getTime(), before.firstAttemptAt!.getTime(), 'recovery never resets first_attempt_at');
});
