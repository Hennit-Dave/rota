import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { createTestShards, type Shards } from '../db/clients.js';
import type { ShardId } from '../db/shard.js';
import { createEmailHandler, emailIdempotencyKey } from './email.js';
import { cleanupEmails, FakeResend, job, makeInviteEmail } from './email.testkit.js';
import { createWorkProcessor, ContentionError } from './worker.js';

let shards: Shards;
before(() => {
  shards = createTestShards({ primaryMax: 3 });
});
afterEach(cleanupEmails);
after(async () => {
  await cleanupEmails();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
});

const processorFor = (resend: FakeResend, opts: { maxAttempts?: number } = {}) =>
  createWorkProcessor(shards, { email: createEmailHandler({ resend }) }, { leaseMs: 10_000, maxAttempts: opts.maxAttempts ?? 5 });
const row = (shard: ShardId, id: string) => shards[shard].primary.workRow.findUniqueOrThrow({ where: { id } });

async function capture<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    return { value: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

for (const shard of ['A', 'B'] as const) {
  test(`shard ${shard}: sends the STORED payload with the stable key, stamps first_attempt_at BEFORE the call, records sent_at and the message ID, and scrubs the body`, async () => {
    const made = await makeInviteEmail(shards, shard);
    const before = await row(shard, made.workRowId);
    const resend = new FakeResend();
    let stampedBeforeCall: Date | null | undefined;
    resend.onCall = async () => {
      stampedBeforeCall = (await row(shard, made.workRowId)).firstAttemptAt;
    };

    await processorFor(resend)(job(before, shard));

    assert.equal(resend.calls.length, 1);
    assert.equal(resend.calls[0]!.key, `email-${made.workRowId}`);
    assert.equal(resend.calls[0]!.key, emailIdempotencyKey(made.workRowId));
    const stored = before.payload as { from: string; replyTo: string; to: string[]; subject: string; html: string; text: string };
    assert.deepEqual(resend.calls[0]!.payload, { from: stored.from, replyTo: stored.replyTo, to: stored.to, subject: stored.subject, html: stored.html, text: stored.text });
    assert.ok(stampedBeforeCall instanceof Date, 'first_attempt_at was committed before the Resend call');

    const after = await row(shard, made.workRowId);
    assert.equal(after.status, 'done');
    assert.ok(after.sentAt);
    assert.match(after.providerMessageId ?? '', /^msg_/);
    assert.ok(after.firstAttemptAt && after.firstAttemptAt <= after.sentAt);
    const scrubbed = after.payload as Record<string, unknown>;
    assert.equal(scrubbed.html, undefined, 'the body (and the link in it) is gone');
    assert.equal(scrubbed.text, undefined);
    assert.equal(scrubbed.scrubbed, true);
    assert.deepEqual(scrubbed.to, [made.to]);
    assert.equal(scrubbed.invitationId, made.invitationId);
    assert.ok(!JSON.stringify(scrubbed).includes(made.secret), 'the raw token no longer exists anywhere on the row');
  });
}

test('a retryable failure releases the claim; the retry sends the SAME key and the SAME payload, once, and first_attempt_at does not move', async () => {
  const made = await makeInviteEmail(shards, 'A');
  const resend = new FakeResend();
  resend.script = ['retryable', 'ok'];
  const processor = processorFor(resend);

  await assert.rejects(() => processor(job({ id: made.workRowId }, 'A')), /retryable/);
  const mid = await row('A', made.workRowId);
  assert.equal(mid.status, 'pending', 'released for the retry');
  assert.equal(mid.claimToken, null);
  assert.equal(mid.executionAttempts, 1);
  assert.ok(mid.firstAttemptAt);

  await processor(job({ id: made.workRowId }, 'A'));
  const done = await row('A', made.workRowId);
  assert.equal(done.status, 'done');
  assert.equal(done.executionAttempts, 2);
  assert.equal(done.firstAttemptAt!.getTime(), mid.firstAttemptAt!.getTime(), 'first_attempt_at is written once and never reset');
  assert.equal(resend.calls.length, 2);
  assert.equal(resend.calls[0]!.key, resend.calls[1]!.key);
  assert.deepEqual(resend.calls[0]!.payload, resend.calls[1]!.payload, 'exactly the stored payload both times');
  assert.equal(resend.deliveries, 1);
});

test('a LOST RESPONSE (Resend accepted it, the answer never arrived): the retry gets the first answer back and only ONE email exists', async () => {
  const made = await makeInviteEmail(shards, 'B');
  const resend = new FakeResend();
  resend.script = ['lost_response', 'ok'];
  const processor = processorFor(resend);

  await assert.rejects(() => processor(job({ id: made.workRowId }, 'B')), /timeout/);
  assert.equal((await row('B', made.workRowId)).sentAt, null, 'nothing was recorded: we do not know');
  assert.equal(resend.deliveries, 1, 'but Resend did accept it');

  await processor(job({ id: made.workRowId }, 'B'));
  const done = await row('B', made.workRowId);
  assert.ok(done.sentAt);
  assert.equal(resend.calls.length, 2);
  assert.equal(resend.deliveries, 1, 'the same key: no second delivery');
});

test('recovery bumps the generation but the idempotency key and first_attempt_at stay the same (the key is the ROW, never the generation)', async () => {
  const made = await makeInviteEmail(shards, 'A');
  const resend = new FakeResend();
  resend.script = ['retryable', 'ok'];
  const processor = processorFor(resend);
  await assert.rejects(() => processor(job({ id: made.workRowId }, 'A', 1)));
  const stamp = (await row('A', made.workRowId)).firstAttemptAt!;

  await shards.A.primary.$executeRaw`UPDATE work_rows SET generation = 2, recovery_count = recovery_count + 1 WHERE id = ${made.workRowId}::uuid`; // what a sweep does
  await processor(job({ id: made.workRowId }, 'A', 2));

  const done = await row('A', made.workRowId);
  assert.equal(done.status, 'done');
  assert.equal(done.firstAttemptAt!.getTime(), stamp.getTime());
  assert.deepEqual(resend.calls.map((c) => c.key), [`email-${made.workRowId}`, `email-${made.workRowId}`]);
});

test('the 23-hour rule: past 23 hours since first_attempt_at the row is FAILED for a human and nothing is sent; at 22h59m it still sends', async () => {
  const late = await makeInviteEmail(shards, 'A');
  await shards.A.primary.$executeRaw`UPDATE work_rows SET first_attempt_at = NOW() - interval '24 hours' WHERE id = ${late.workRowId}::uuid`;
  const resend = new FakeResend();
  const processor = processorFor(resend);

  await processor(job({ id: late.workRowId }, 'A')); // resolves: a terminal failure is not retried
  const failed = await row('A', late.workRowId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureReason, 'terminal: email_window_expired');
  assert.equal(resend.calls.length, 0, 'nothing was sent');
  assert.equal(failed.sentAt, null);
  await processor(job({ id: late.workRowId }, 'A')); // a later job for the same row is a no-op
  assert.equal(resend.calls.length, 0);

  const justInside = await makeInviteEmail(shards, 'B');
  await shards.B.primary.$executeRaw`UPDATE work_rows SET first_attempt_at = NOW() - interval '22 hours 59 minutes' WHERE id = ${justInside.workRowId}::uuid`;
  await processor(job({ id: justInside.workRowId }, 'B'));
  assert.equal((await row('B', justInside.workRowId)).status, 'done');
  assert.equal(resend.deliveries, 1);
});

test('a spent daily quota is terminal at once: failed with the reason, ONE call, the attempt budget is not burned; a retryable error is not terminal', async () => {
  const made = await makeInviteEmail(shards, 'A');
  const resend = new FakeResend();
  resend.script = ['quota'];
  const processor = processorFor(resend);
  await processor(job({ id: made.workRowId }, 'A')); // resolves: BullMQ must not retry it
  const failed = await row('A', made.workRowId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureReason, 'terminal: daily_quota_exceeded');
  assert.equal(failed.executionAttempts, 1);
  assert.equal(resend.calls.length, 1);
  assert.ok(failed.payload && (failed.payload as { html?: string }).html, 'the frozen payload is kept on a failed row for a human to retry');
  await processor(job({ id: made.workRowId }, 'A'));
  assert.equal(resend.calls.length, 1, 'a failed row is never retried by a later job');

  const rejected = await makeInviteEmail(shards, 'B');
  resend.script = ['bad_request'];
  await processor(job({ id: rejected.workRowId }, 'B'));
  assert.equal((await row('B', rejected.workRowId)).failureReason, 'terminal: validation_error');
});

test('a row that already has sent_at never sends again, even if its job runs again', async () => {
  const made = await makeInviteEmail(shards, 'A');
  await shards.A.primary.$executeRaw`UPDATE work_rows SET sent_at = NOW(), provider_message_id = 'msg_before' WHERE id = ${made.workRowId}::uuid`;
  const resend = new FakeResend();
  await processorFor(resend)(job({ id: made.workRowId }, 'A'));
  assert.equal(resend.calls.length, 0);
  const r = await row('A', made.workRowId);
  assert.equal(r.status, 'done');
  assert.equal(r.providerMessageId, 'msg_before');
});

test('a dead invitation sends NOTHING: revoked, replaced by a resend, accepted or expired; the row ends done without sent_at, and the body is scrubbed', async () => {
  const resend = new FakeResend();
  const processor = processorFor(resend);
  const cases: Array<[string, (m: Awaited<ReturnType<typeof makeInviteEmail>>) => Promise<unknown>]> = [
    ['revoked', (m) => shards.A.primary.$executeRaw`UPDATE invitations SET revoked_at = NOW() WHERE id = ${m.invitationId}::uuid`],
    ['replaced', (m) => shards.A.primary.$executeRaw`UPDATE invitations SET token_hash = decode(${'ab'.repeat(32)}, 'hex') WHERE id = ${m.invitationId}::uuid`],
    ['accepted', (m) => shards.A.primary.$executeRaw`UPDATE invitations SET accepted_at = NOW() WHERE id = ${m.invitationId}::uuid`],
    ['expired', (m) => shards.A.primary.$executeRaw`UPDATE invitations SET expires_at = NOW() - interval '1 minute' WHERE id = ${m.invitationId}::uuid`],
  ];
  for (const [label, kill] of cases) {
    const made = await makeInviteEmail(shards, 'A');
    await kill(made);
    await processor(job({ id: made.workRowId }, 'A'));
    const r = await row('A', made.workRowId);
    assert.equal(r.status, 'done', label);
    assert.equal(r.sentAt, null, label);
    assert.equal(r.firstAttemptAt, null, `${label}: no send was attempted`);
    assert.equal((r.payload as { html?: string }).html, undefined, `${label}: scrubbed`);
  }
  assert.equal(resend.calls.length, 0, 'not one of them reached Resend');
});

test('ownership lost: with a wrong claim token the handler makes no call and stamps nothing; with the lease gone after the stamp it makes no call either', async () => {
  const handler = createEmailHandler({ resend: new FakeResend() });
  const resend = new FakeResend();
  const guarded = createEmailHandler({ resend });
  const made = await makeInviteEmail(shards, 'A');
  const claimToken = randomUUID();
  await shards.A.primary.$executeRaw`UPDATE work_rows SET status = 'claimed'::"work_status", claim_token = ${claimToken}::uuid, claim_expires_at = NOW() + interval '1 minute', execution_attempts = 1 WHERE id = ${made.workRowId}::uuid`;
  const claimed = await row('A', made.workRowId);
  void handler;

  await assert.rejects(
    () => guarded({ prisma: shards.A.primary, row: claimed, job: {} as any, claimToken: randomUUID(), renewLease: async () => true }),
    /ownership lost/,
  );
  assert.equal(resend.calls.length, 0);
  assert.equal((await row('A', made.workRowId)).firstAttemptAt, null, 'a stale execution cannot even write first_attempt_at');

  await assert.rejects(
    () => guarded({ prisma: shards.A.primary, row: claimed, job: {} as any, claimToken, renewLease: async () => false }),
    /ownership lost/,
  );
  assert.equal(resend.calls.length, 0, 'the lease could not be renewed: no external call');
});

test('two executions of one job that OVERLAP: exactly one claims and sends; the other is told to retry (ContentionError), never "succeeds"', async () => {
  const made = await makeInviteEmail(shards, 'B');
  const resend = new FakeResend();
  // Deterministic overlap: the first execution is held INSIDE the Resend call (it owns a live claim) until the second has been turned away.
  let enteredSend!: () => void;
  const insideSend = new Promise<void>((resolve) => (enteredSend = resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  resend.onCall = async () => {
    enteredSend();
    await hold;
  };
  const processor = processorFor(resend);

  const first = processor(job({ id: made.workRowId }, 'B'));
  await insideSend;
  const second = await processor(job({ id: made.workRowId }, 'B')).then(
    () => 'resolved' as const,
    (error: unknown) => error,
  );
  assert.ok(second instanceof ContentionError, 'the loser retries instead of exiting "successfully"');
  assert.equal((await row('B', made.workRowId)).status, 'claimed', 'the first still owns the row while it sends');
  release();
  await first;

  assert.equal(resend.calls.length, 1, 'one call to Resend');
  assert.equal(resend.deliveries, 1);
  const r = await row('B', made.workRowId);
  assert.equal(r.status, 'done');
  assert.equal(r.executionAttempts, 1, 'contention does not touch execution_attempts');
});

test('a second execution that starts AFTER the first has finished exits cleanly and sends nothing (a done row is a stale job)', async () => {
  const made = await makeInviteEmail(shards, 'B');
  const resend = new FakeResend();
  const processor = processorFor(resend);
  await processor(job({ id: made.workRowId }, 'B'));
  await processor(job({ id: made.workRowId }, 'B')); // resolves: nothing to do, nothing sent
  assert.equal(resend.calls.length, 1);
  assert.equal(resend.deliveries, 1);
  const r = await row('B', made.workRowId);
  assert.equal(r.status, 'done');
  assert.equal(r.executionAttempts, 1);
});

test('attempt budget: repeated failures end FAILED at the max, every attempt used the same key and payload, and a later job sends nothing', async () => {
  const made = await makeInviteEmail(shards, 'A');
  const resend = new FakeResend();
  resend.script = ['retryable', 'retryable', 'retryable'];
  const processor = processorFor(resend, { maxAttempts: 3 });
  for (let i = 0; i < 3; i++) await assert.rejects(() => processor(job({ id: made.workRowId }, 'A')));
  const failed = await row('A', made.workRowId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.executionAttempts, 3);
  assert.equal(new Set(resend.calls.map((c) => c.key)).size, 1);
  assert.equal(new Set(resend.calls.map((c) => JSON.stringify(c.payload))).size, 1);
  assert.equal(resend.deliveries, 0);
  await processor(job({ id: made.workRowId }, 'A'));
  assert.equal(resend.calls.length, 3, 'no fourth call');
});

test('LOGS: every line carries the row and the request that made it, and none carries the token, the link or the recipient', async () => {
  const origin = randomUUID();
  const made = await makeInviteEmail(shards, 'B', { originRequestId: origin });
  const resend = new FakeResend();
  resend.script = ['retryable', 'ok'];
  const processor = processorFor(resend);
  const first = await capture(() => processor(job({ id: made.workRowId }, 'B')));
  const second = await capture(() => processor(job({ id: made.workRowId }, 'B')));
  const lines = [...first.lines, ...second.lines];
  assert.ok(lines.some((l) => l.includes('[email]') && l.includes(`row_id=${made.workRowId}`) && l.includes(`origin_request_id=${origin}`) && l.includes('outcome=sent')));
  assert.ok(lines.some((l) => l.startsWith('[job:execution]') && l.includes(`origin_request_id=${origin}`)), 'the execution log carries the origin request');
  const text = lines.join('\n');
  for (const needle of [made.secret, made.token, made.to, 'rota.davebuilds.design/invite']) {
    assert.ok(!text.includes(needle), `a log line contains ${needle.slice(0, 14)}...`);
  }
});
