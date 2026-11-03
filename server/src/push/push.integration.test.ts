import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { createTestShards, type Shards } from '../db/clients.js';
import { shardFor, type ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { job } from '../jobs/email.testkit.js';
import { createWorkProcessor } from '../jobs/worker.js';
import { changeSetting } from '../settings/service.js';
import { deleteDeviceById, devicesOf, registerDevice, unregisterDevice } from './devices.js';
import { ExpoPushError, type ExpoMessage, type ExpoPushClient, type Receipt, type Ticket } from './expo.js';
import { createPushEventHandler, createPushHandler, createPushReceiptsHandler, PUSH_EVENT_KIND, PUSH_KIND, PUSH_RECEIPTS_KIND } from './jobs.js';
import { reschedulePushRows } from './reschedule.js';
import type { PushPayload } from './message.js';

/**
 * The push jobs against the TEST shards (never the real ones), with a fake Expo. They check what the plan promised: who is told, when, and what is recorded;
 * nothing here sends a real push. Everything these tests create is removed again by `cleanup`, including the work rows (issue #62).
 */

let shards: Shards;
before(() => {
  shards = createTestShards({ primaryMax: 3 });
});

const A = () => shards.A.primary;
const users: string[] = [];
const teams: string[] = [];
afterEach(cleanup);
after(async () => {
  await cleanup();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
});

async function cleanup(): Promise<void> {
  if (users.length === 0 && teams.length === 0) return;
  const pushRows = await A().$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM work_rows WHERE kind = 'push' AND payload->>'userId' = ANY(${users}::text[])`;
  const ids = pushRows.map((r) => r.id);
  for (const shard of ['A', 'B'] as const) {
    const p = shards[shard].primary;
    await p.$executeRaw`DELETE FROM work_rows WHERE kind = 'push_receipts' AND payload->>'pushRowId' = ANY(${ids}::text[])`;
    await p.$executeRaw`DELETE FROM work_rows WHERE kind IN ('push', 'push_event') AND (payload->>'userId' = ANY(${users}::text[]) OR payload->>'teamId' = ANY(${teams}::text[]))`;
  }
  await A().user.deleteMany({ where: { id: { in: users.splice(0) } } }); // cascades device tokens, settings and deliveries
  for (const id of teams.splice(0)) await shards[shardFor(id)].primary.team.deleteMany({ where: { id } });
}

async function makeUser(): Promise<string> {
  const u = await A().user.create({ data: { email: `push-${randomUUID()}@example.test`, name: 'Push Tester' } });
  users.push(u.id);
  return u.id;
}

/** A team on a chosen shard with an owner, and optionally a manager. */
async function makeTeam(shard: ShardId, ownerId: string, extra: Array<{ userId: string; role: 'manager' | 'staff' }> = []): Promise<string> {
  let teamId = randomUUID();
  while (shardFor(teamId) !== shard) teamId = randomUUID();
  const p = shards[shard].primary;
  await p.team.create({ data: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos' } });
  teams.push(teamId);
  await p.membership.create({ data: { teamId, userId: ownerId, role: 'owner' } });
  for (const m of extra) await p.membership.create({ data: { teamId, userId: m.userId, role: m.role } });
  return teamId;
}

const token = () => `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;

type Step = 'ok' | 'retryable' | 'terminal' | 'DeviceNotRegistered';
class FakeExpo implements ExpoPushClient {
  sent: ExpoMessage[] = [];
  calls = 0;
  script: Step[] = [];
  receipts: Record<string, Receipt> = {};
  private n = 0;
  async send(messages: ExpoMessage[]): Promise<Ticket[]> {
    this.calls += 1;
    const step = this.script.shift() ?? 'ok';
    if (step === 'retryable') throw new ExpoPushError('retryable', 'server_error', 500);
    if (step === 'terminal') throw new ExpoPushError('terminal', 'rejected', 400);
    this.sent.push(...messages);
    return messages.map((): Ticket => (step === 'DeviceNotRegistered' ? { status: 'error', message: 'gone', error: 'DeviceNotRegistered' } : { status: 'ok', id: `T-${++this.n}-${randomUUID()}` }));
  }
  async getReceipts(ids: string[]): Promise<Record<string, Receipt>> {
    const out: Record<string, Receipt> = {};
    for (const id of ids) if (this.receipts[id]) out[id] = this.receipts[id]!;
    return out;
  }
}

const config = { sendTimeoutMs: 1000, receiptDelayMs: 15 * 60_000 };
type Enqueued = { id: string; kind: string; generation: number; runAt: Date; shard: ShardId };

function harness(expo = new FakeExpo()) {
  const enqueued: Enqueued[] = [];
  const enqueue = async (_p: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => {
    enqueued.push({ id: row.id, kind: row.kind, generation: row.generation, runAt: row.runAt, shard });
  };
  const processor = createWorkProcessor(
    shards,
    {
      [PUSH_EVENT_KIND]: createPushEventHandler({ shards, enqueue }),
      [PUSH_KIND]: createPushHandler({ shards, enqueue, expo, config }),
      [PUSH_RECEIPTS_KIND]: createPushReceiptsHandler({ expo, config, enqueue }),
    },
    { leaseMs: 10_000, maxAttempts: 5 },
  );
  return { expo, enqueued, processor };
}

async function quiet(lines: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    await lines();
  } finally {
    Object.assign(console, orig);
  }
  return out;
}

const SWEEP = 2 * 60_000;
async function makePushRow(opts: { userId: string; teamId: string; moment?: PushPayload['moment']; runAt?: Date; status?: 'pending' | 'claimed'; teamTimeZone?: string; shiftId?: string; swapId?: string }): Promise<WorkRow> {
  const payload: PushPayload = {
    dedupeKey: `test:${randomUUID()}`,
    eventRowId: randomUUID(),
    userId: opts.userId,
    teamId: opts.teamId,
    teamTimeZone: opts.teamTimeZone ?? 'Africa/Lagos',
    moment: opts.moment ?? 'renewal_failed',
    title: 'Renewal payment failed',
    body: 'We could not collect the renewal for The Olive Room. Open Rota to fix it.',
    ...(opts.shiftId ? { shiftId: opts.shiftId } : {}),
    ...(opts.swapId ? { swapId: opts.swapId } : {}),
  };
  const runAt = opts.runAt ?? new Date(Date.now() - 1000);
  return A().workRow.create({
    data: {
      kind: PUSH_KIND,
      payload: payload as never,
      runAt,
      availableAt: new Date(runAt.getTime() + SWEEP),
      status: opts.status ?? 'pending',
      ...(opts.status === 'claimed' ? { claimToken: randomUUID(), claimExpiresAt: new Date(Date.now() + 60_000) } : {}),
    },
  });
}
const rowOf = (id: string, shard: ShardId = 'A') => shards[shard].primary.workRow.findUniqueOrThrow({ where: { id } });
const deliveriesOf = (workRowId: string) =>
  A().$queryRaw<Array<{ status: string; ticket_id: string | null; error: string | null; receipt_checked_at: Date | null }>>`
    SELECT status::text AS status, ticket_id, error, receipt_checked_at FROM push_deliveries WHERE work_row_id = ${workRowId}::uuid ORDER BY created_at, id`;

// ---- devices ---------------------------------------------------------------------------------------------------------------------------------------------

test('devices: a token registers once, registering it again changes nothing, and it MOVES when another user signs in on that phone', async () => {
  const u1 = await makeUser();
  const u2 = await makeUser();
  const t = token();
  await registerDevice(A(), u1, t);
  await registerDevice(A(), u1, t);
  assert.equal((await devicesOf(A(), u1)).length, 1, 'same token twice is one row');
  await registerDevice(A(), u2, t);
  assert.equal((await devicesOf(A(), u1)).length, 0, 'the first user no longer gets pushes on that phone');
  assert.equal((await devicesOf(A(), u2)).length, 1);
});

test("devices: unregister removes only the caller's own token; another user's token and an unknown token are untouched", async () => {
  const u1 = await makeUser();
  const u2 = await makeUser();
  const mine = token();
  const theirs = token();
  await registerDevice(A(), u1, mine);
  await registerDevice(A(), u2, theirs);
  assert.equal(await unregisterDevice(A(), u1, theirs), 0, 'u1 cannot remove u2 token');
  assert.equal(await unregisterDevice(A(), u1, token()), 0, 'an unknown token is not an error');
  assert.equal((await devicesOf(A(), u2)).length, 1);
  assert.equal(await unregisterDevice(A(), u1, mine), 1);
  assert.equal((await devicesOf(A(), u1)).length, 0);
});

test('devices: the database itself refuses a token that is not an Expo token', async () => {
  const u = await makeUser();
  await assert.rejects(() => registerDevice(A(), u, 'fcm-token-not-expo'), /device_tokens_expo_token_shape|check constraint/i);
});

// ---- fan-out ---------------------------------------------------------------------------------------------------------------------------------------------

for (const shard of ['A', 'B'] as const) {
  test(`fan-out (team on shard ${shard}): one push row per recipient on shard A; a replay creates nothing; a recipient in quiet hours is scheduled for the end of them`, async () => {
    const owner = await makeUser();
    const team = await makeTeam(shard, owner);
    const { processor, enqueued } = harness();
    // The owner's quiet hours cover the whole day except 06:00 to 06:01, so "now" is inside the window whatever time the test runs.
    await changeSetting(A(), owner, { quietHours: { enabled: true, start: '06:01', end: '06:00' } });
    await changeSetting(A(), owner, { timeZone: 'UTC' });
    const event = await shards[shard].primary.workRow.create({
      data: {
        kind: PUSH_EVENT_KIND,
        runAt: new Date(Date.now() - 1000),
        availableAt: new Date(),
        payload: { moment: 'renewal_failed', teamId: team, recipients: [owner], title: 't', body: 'b' } as never,
      },
    });

    await quiet(() => processor(job(event, shard)));
    const made = await A().$queryRaw<Array<{ id: string; run_at: Date; payload: PushPayload }>>`SELECT id::text AS id, run_at, payload FROM work_rows WHERE kind = 'push' AND payload->>'userId' = ${owner}`;
    assert.equal(made.length, 1, 'one push row, on shard A');
    assert.equal(made[0]!.payload.dedupeKey, `${event.id}:${owner}`);
    assert.equal(made[0]!.payload.teamTimeZone, 'Africa/Lagos', 'the team time zone is frozen on the row for the fallback');
    assert.ok(made[0]!.run_at.getTime() > Date.now() + 60_000 || made[0]!.run_at.getUTCHours() === 6, 'scheduled for the end of quiet hours, not now');
    assert.deepEqual(enqueued.map((e) => [e.kind, e.shard]), [[PUSH_KIND, 'A']]);

    // Replay the fan-out (a crash before it was marked done): nothing new, nothing enqueued twice.
    await shards[shard].primary.workRow.update({ where: { id: event.id }, data: { status: 'pending', claimToken: null, claimExpiresAt: null } });
    await quiet(() => processor(job(event, shard)));
    const again = await A().$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM work_rows WHERE kind = 'push' AND payload->>'userId' = ${owner}`;
    assert.equal(again[0]!.n, 1, 'the unique key on (event, user) stops a second row');
    assert.equal(enqueued.length, 1);
  });
}

// ---- send ------------------------------------------------------------------------------------------------------------------------------------------------

test('send: the Owner gets one push per device; the phone is told a type, a moment and a team id and nothing else; deliveries record the tickets; receipts are scheduled', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  await registerDevice(A(), owner, token());
  const row = await makePushRow({ userId: owner, teamId: team });
  const { processor, expo, enqueued } = harness();

  await quiet(() => processor(job(row, 'A')));

  assert.equal(expo.sent.length, 2, 'both devices');
  assert.equal(expo.calls, 1, 'one batched call');
  for (const m of expo.sent) {
    assert.deepEqual(m.data, { v: 1, type: 'billing', moment: 'renewal_failed', teamId: team });
    assert.equal(m.channelId, 'billing', 'billing has its own channel (ADR 0033)');
    assert.doesNotMatch(JSON.stringify(m), /\$|cent|amount|price|\/billing/i, 'no money and no path in what the phone receives');
  }
  const d = await deliveriesOf(row.id);
  assert.deepEqual(d.map((x) => x.status), ['sent', 'sent']);
  assert.ok(d.every((x) => x.ticket_id));
  assert.equal((await rowOf(row.id)).status, 'done');
  const receipts = await A().$queryRaw<Array<{ run_at: Date; payload: { pushRowId: string } }>>`SELECT run_at, payload FROM work_rows WHERE kind = 'push_receipts' AND payload->>'pushRowId' = ${row.id}`;
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0]!.run_at.getTime() > Date.now() + 14 * 60_000, 'receipts are looked at about 15 minutes later');
  assert.deepEqual(enqueued.map((e) => e.kind), [PUSH_RECEIPTS_KIND]);
});

test('send: billing goes to the Owner only. A manager (or anyone who is not the Owner) gets nothing, whatever their settings say', async () => {
  const owner = await makeUser();
  const manager = await makeUser();
  const team = await makeTeam('A', owner, [{ userId: manager, role: 'manager' }]);
  await registerDevice(A(), manager, token());
  await changeSetting(A(), manager, { notifyBilling: true });
  const row = await makePushRow({ userId: manager, teamId: team });
  const { processor, expo } = harness();

  const lines = await quiet(() => processor(job(row, 'A')));

  assert.equal(expo.calls, 0);
  assert.match(lines.join('\n'), /outcome=skipped reason=not_owner/);
  assert.equal((await rowOf(row.id)).status, 'done');
});

test('send: an Owner who has switched notifyBilling OFF still gets the failed-renewal and read-only pushes (essential), but a switched-off shift toggle does not matter here', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  await changeSetting(A(), owner, { notifyBilling: false });
  for (const moment of ['renewal_failed', 'renewal_read_only'] as const) {
    const row = await makePushRow({ userId: owner, teamId: team, moment });
    const { processor, expo } = harness();
    await quiet(() => processor(job(row, 'A')));
    assert.equal(expo.sent.length, 1, `${moment} is sent although notifyBilling is off`);
  }
});

test('send: quiet hours still apply to the essential pushes. Inside the window nothing is sent and the row is handed back for the end of it, as a new generation', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  await changeSetting(A(), owner, { timeZone: 'UTC' });
  await changeSetting(A(), owner, { quietHours: { enabled: true, start: '06:01', end: '06:00' } }); // quiet at every minute but 06:00
  const row = await makePushRow({ userId: owner, teamId: team });
  const { processor, expo, enqueued } = harness();

  const lines = await quiet(() => processor(job(row, 'A')));

  assert.equal(expo.calls, 0);
  const after = await rowOf(row.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.generation, 2, 'a new generation, so the old schedule cannot fire');
  assert.equal(after.claimToken, null);
  assert.ok(after.runAt.getTime() > Date.now(), 'in the future');
  assert.equal(after.runAt.getUTCHours(), 6);
  assert.equal(after.runAt.getUTCMinutes(), 0);
  assert.deepEqual(enqueued.map((e) => [e.id, e.generation, e.kind]), [[row.id, 2, PUSH_KIND]]);
  assert.match(lines.join('\n'), /outcome=deferred reason=quiet_hours/);
});

test('send: the settings are read WHEN THE JOB RUNS. Quiet hours switched on after the row was made still hold it back; switched off, it goes', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  await changeSetting(A(), owner, { timeZone: 'UTC' });
  const first = await makePushRow({ userId: owner, teamId: team });
  await changeSetting(A(), owner, { quietHours: { enabled: true, start: '06:01', end: '06:00' } });
  const h1 = harness();
  await quiet(() => h1.processor(job(first, 'A')));
  assert.equal(h1.expo.calls, 0, 'held back by settings that did not exist when the row was made');

  await changeSetting(A(), owner, { quietHours: { enabled: false, start: '06:01', end: '06:00' } });
  const second = await makePushRow({ userId: owner, teamId: team });
  const h2 = harness();
  await quiet(() => h2.processor(job(second, 'A')));
  assert.equal(h2.expo.calls, 1);
});

test('send: a person with no registered device is not an error: nothing is called and the row is done', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  const row = await makePushRow({ userId: owner, teamId: team });
  const { processor, expo } = harness();
  const lines = await quiet(() => processor(job(row, 'A')));
  assert.equal(expo.calls, 0);
  assert.match(lines.join('\n'), /reason=no_devices/);
  assert.equal((await rowOf(row.id)).status, 'done');
});

test('send: Expo says a device is no longer registered. That token is deleted; the other device is still sent to', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  await registerDevice(A(), owner, token());
  const row = await makePushRow({ userId: owner, teamId: team });
  const expo = new FakeExpo();
  // The fake answers every message in a call with the same step, so send two calls' worth: first call DeviceNotRegistered for both would delete both.
  // Instead make a per-token script: the first device's ticket is an error, the second is ok.
  const original = expo.send.bind(expo);
  expo.send = async (messages) => {
    const tickets = await original(messages);
    return tickets.map((t, i): Ticket => (i === 0 ? { status: 'error', message: 'gone', error: 'DeviceNotRegistered' } : t));
  };
  const { processor } = harness(expo);

  await quiet(() => processor(job(row, 'A')));

  assert.equal((await devicesOf(A(), owner)).length, 1, 'the dead token is gone');
  const d = await deliveriesOf(row.id);
  assert.deepEqual(d.map((x) => x.status), ['sent'], 'the live device was sent to');
});

test('send: a failure Expo says is retryable leaves the deliveries `sending`; the retry sends them again, ONCE each, and logs a possible duplicate', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  const row = await makePushRow({ userId: owner, teamId: team });
  const expo = new FakeExpo();
  expo.script = ['retryable', 'ok'];
  const { processor } = harness(expo);

  const first = await quiet(async () => {
    await assert.rejects(() => processor(job(row, 'A')), /retryable|expo push/i);
  });
  assert.match(first.join('\n'), /outcome=retryable_failure/);
  const afterFirst = await rowOf(row.id);
  assert.equal(afterFirst.status, 'pending', 'released for the retry');
  assert.deepEqual((await deliveriesOf(row.id)).map((x) => x.status), ['sending']);

  const second = await quiet(() => processor(job(afterFirst, 'A')));
  assert.match(second.join('\n'), /outcome=possible_duplicate/);
  assert.equal(expo.sent.length, 1, 'the first call threw before Expo accepted anything; the retry is the only accepted send');
  assert.deepEqual((await deliveriesOf(row.id)).map((x) => x.status), ['sent'], 'one delivery record, one device: never a second row');
  assert.equal((await rowOf(row.id)).status, 'done');
});

test('send: a terminal answer from Expo (a rejected request) marks the deliveries and the row failed, and is not retried', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  const row = await makePushRow({ userId: owner, teamId: team });
  const expo = new FakeExpo();
  expo.script = ['terminal'];
  const { processor } = harness(expo);
  await quiet(() => processor(job(row, 'A')));
  const after = await rowOf(row.id);
  assert.equal(after.status, 'failed');
  assert.match(after.failureReason ?? '', /terminal: rejected/);
  assert.deepEqual((await deliveriesOf(row.id)).map((x) => [x.status, x.error]), [['failed', 'rejected']]);
});

// ---- receipts --------------------------------------------------------------------------------------------------------------------------------------------

test('receipts: ok is recorded; DeviceNotRegistered deletes the token; a receipt Expo does not have yet defers the check as a new generation', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  const tokenOk = token();
  const tokenDead = token();
  const tokenLate = token();
  for (const t of [tokenOk, tokenDead, tokenLate]) await registerDevice(A(), owner, t);
  const row = await makePushRow({ userId: owner, teamId: team });
  const expo = new FakeExpo();
  const { processor, enqueued } = harness(expo);
  await quiet(() => processor(job(row, 'A')));
  const tickets = await A().$queryRaw<Array<{ ticket_id: string; token: string }>>`
    SELECT d.ticket_id, t.expo_token AS token FROM push_deliveries d JOIN device_tokens t ON t.id = d.device_token_id WHERE d.work_row_id = ${row.id}::uuid`;
  const idOf = (tok: string) => tickets.find((x) => x.token === tok)!.ticket_id;
  expo.receipts[idOf(tokenOk)] = { status: 'ok' };
  expo.receipts[idOf(tokenDead)] = { status: 'error', message: 'gone', error: 'DeviceNotRegistered' };
  // tokenLate has no receipt yet.

  const receiptsRow = await A().workRow.findFirstOrThrow({ where: { kind: PUSH_RECEIPTS_KIND, payload: { path: ['pushRowId'], equals: row.id } } });
  await A().workRow.update({ where: { id: receiptsRow.id }, data: { runAt: new Date(Date.now() - 1000) } });
  enqueued.length = 0;
  await quiet(() => processor(job(receiptsRow, 'A')));

  const devices = (await devicesOf(A(), owner)).map((d) => d.expoToken).sort();
  assert.deepEqual(devices, [tokenOk, tokenLate].sort(), 'the dead token is deleted, the others stay');
  const left = await deliveriesOf(row.id);
  assert.equal(left.filter((x) => x.receipt_checked_at).length, 1, 'only the ok one is checked off');
  const after = await rowOf(receiptsRow.id);
  assert.equal(after.generation, 2, 'the late receipt is looked at again later, from the same row');
  assert.equal(after.status, 'pending');
  assert.deepEqual(enqueued.map((e) => [e.kind, e.generation]), [[PUSH_RECEIPTS_KIND, 2]]);
});

// ---- rescheduling from a settings change -----------------------------------------------------------------------------------------------------------------

test('a quiet-hours change moves the user\'s waiting pushes in the same transaction; claimed rows lose their claim; other users and finished rows are untouched; no change = no churn', async () => {
  const me = await makeUser();
  const other = await makeUser();
  const team = await makeTeam('A', me);
  await changeSetting(A(), me, { timeZone: 'UTC' });
  const future = new Date(Date.now() + 5 * 3600_000);
  const pending = await makePushRow({ userId: me, teamId: team, runAt: future });
  const claimed = await makePushRow({ userId: me, teamId: team, status: 'claimed' });
  const done = await makePushRow({ userId: me, teamId: team });
  await A().workRow.update({ where: { id: done.id }, data: { status: 'done' } });
  const others = await makePushRow({ userId: other, teamId: team, runAt: future });

  // Quiet hours OFF: the pending row that was waiting for the future may go now; the claimed row is handed back too.
  const moved = await A().$transaction(async (tx) => {
    const settings = await changeSetting(tx as PrismaClient, me, { quietHours: { enabled: false, start: '22:00', end: '06:00' } });
    return reschedulePushRows(tx, me, settings, new Date());
  });
  const byId = new Map(moved.map((m) => [m.id, m]));
  assert.ok(byId.has(pending.id) && byId.has(claimed.id), 'pending and claimed rows both move');
  assert.equal(byId.size, 2, 'the done row and the other user\'s row do not');
  const p = await rowOf(pending.id);
  assert.equal(p.generation, 2);
  assert.ok(p.runAt.getTime() <= Date.now() + 1000, 'now that nothing is quiet, it may go at once');
  const c = await rowOf(claimed.id);
  assert.equal(c.status, 'pending');
  assert.equal(c.claimToken, null, 'the claim is cleared, so the running execution fails its next ownership update');
  assert.equal((await rowOf(done.id)).generation, 1);
  assert.equal((await rowOf(others.id)).generation, 1);

  // Quiet hours ON (quiet every minute but 06:00): the pending row moves to 06:00. Asking for the same again changes nothing.
  const into = await A().$transaction(async (tx) => {
    const s = await changeSetting(tx as PrismaClient, me, { quietHours: { enabled: true, start: '06:01', end: '06:00' } });
    return reschedulePushRows(tx, me, s, new Date());
  });
  assert.ok(into.length >= 1);
  const gen = (await rowOf(pending.id)).generation;
  assert.equal((await rowOf(pending.id)).runAt.getUTCHours(), 6);
  const same = await A().$transaction(async (tx) => {
    const s = await changeSetting(tx as PrismaClient, me, { quietHours: { enabled: true, start: '06:01', end: '06:00' } });
    return reschedulePushRows(tx, me, s, new Date());
  });
  assert.equal(same.length, 0, 'unchanged schedule: nothing rescheduled');
  assert.equal((await rowOf(pending.id)).generation, gen);
});

test('deleting a device token also deletes its delivery records, so a removed phone leaves nothing behind', async () => {
  const owner = await makeUser();
  const team = await makeTeam('A', owner);
  await registerDevice(A(), owner, token());
  const row = await makePushRow({ userId: owner, teamId: team });
  const { processor } = harness();
  await quiet(() => processor(job(row, 'A')));
  const [device] = await devicesOf(A(), owner);
  await deleteDeviceById(A(), device!.id);
  assert.equal((await deliveriesOf(row.id)).length, 0);
});

// ---- shift and swap pushes (ADR 0033) -----------------------------------------------------------------------------------------------------------------

test('a shift push goes on the shift_changes channel with the shift id in the data, to any ACTIVE member (a Staff member, not only an Owner)', async () => {
  const owner = await makeUser();
  const staff = await makeUser();
  const team = await makeTeam('A', owner, [{ userId: staff, role: 'staff' }]);
  await registerDevice(A(), staff, token());
  const shiftId = randomUUID();
  const row = await makePushRow({ userId: staff, teamId: team, moment: 'shift_updated', shiftId });
  const { processor, expo } = harness();
  await quiet(() => processor(job(row, 'A')));
  assert.equal(expo.sent.length, 1);
  assert.equal(expo.sent[0]!.channelId, 'shift_changes');
  assert.deepEqual(expo.sent[0]!.data, { v: 1, type: 'shift_changes', moment: 'shift_updated', teamId: team, shiftId });
});

test('a swap push goes on the swap_updates channel with the swap id in the data', async () => {
  const owner = await makeUser();
  const staff = await makeUser();
  const team = await makeTeam('B', owner, [{ userId: staff, role: 'staff' }]);
  await registerDevice(A(), staff, token());
  const swapId = randomUUID();
  const row = await makePushRow({ userId: staff, teamId: team, moment: 'swap_approved', swapId });
  const { processor, expo } = harness();
  await quiet(() => processor(job(row, 'A')));
  assert.equal(expo.sent[0]!.channelId, 'swap_updates');
  assert.deepEqual(expo.sent[0]!.data, { v: 1, type: 'swap_updates', moment: 'swap_approved', teamId: team, swapId });
});

test('the per-type switches apply to shift and swap pushes (they are not essential), each only to its own type', async () => {
  const owner = await makeUser();
  const staff = await makeUser();
  const team = await makeTeam('A', owner, [{ userId: staff, role: 'staff' }]);
  await registerDevice(A(), staff, token());
  await changeSetting(A(), staff, { notifyShiftChanges: false });

  const shiftRow = await makePushRow({ userId: staff, teamId: team, moment: 'shift_created', shiftId: randomUUID() });
  const h1 = harness();
  const lines = await quiet(() => h1.processor(job(shiftRow, 'A')));
  assert.equal(h1.expo.calls, 0, 'shift changes are switched off');
  assert.match(lines.join('\n'), /outcome=skipped reason=type_off type=shift_changes/);

  const swapRow = await makePushRow({ userId: staff, teamId: team, moment: 'swap_rejected', swapId: randomUUID() });
  const h2 = harness();
  await quiet(() => h2.processor(job(swapRow, 'A')));
  assert.equal(h2.expo.sent.length, 1, 'swap updates are still on: the shift switch does not touch them');

  await changeSetting(A(), staff, { notifySwapUpdates: false });
  const swapRow2 = await makePushRow({ userId: staff, teamId: team, moment: 'swap_requested', swapId: randomUUID() });
  const h3 = harness();
  await quiet(() => h3.processor(job(swapRow2, 'A')));
  assert.equal(h3.expo.calls, 0, 'swap updates are now switched off too');
});

test('someone who is not an active member any more gets nothing: a person who left, and a person deactivated at a reduction', async () => {
  const owner = await makeUser();
  const left = await makeUser();
  const deactivated = await makeUser();
  const team = await makeTeam('A', owner, [{ userId: deactivated, role: 'staff' }]);
  for (const u of [left, deactivated]) await registerDevice(A(), u, token());
  await shards[shardFor(team)].primary.membership.updateMany({ where: { teamId: team, userId: deactivated }, data: { deactivatedAt: new Date() } });
  for (const u of [left, deactivated]) {
    const row = await makePushRow({ userId: u, teamId: team, moment: 'shift_deleted', shiftId: randomUUID() });
    const { processor, expo } = harness();
    const lines = await quiet(() => processor(job(row, 'A')));
    assert.equal(expo.calls, 0);
    assert.match(lines.join('\n'), /reason=not_a_member/);
  }
});
