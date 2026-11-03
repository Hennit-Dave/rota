import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createTestShards, type Shards } from '../db/clients.js';
import { shardFor, type ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { createShift, deleteShift, updateShift } from '../shifts/service.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { PUSH_TEXT } from './events.js';

/**
 * The push events of shift and swap changes (ADR 0033): who is told, and that the event commits or rolls back WITH the change. TEST shards, real HTTP; nothing here
 * sends a push (the jobs that send are in `push.integration.test.ts`). The work rows these tests make are removed by the work-row guard (issue #62).
 */
let app: TeamsTestApp;
let shards: Shards;
before(async () => {
  app = await startTeamsTestApp();
  shards = createTestShards({ primaryMax: 2 });
});
after(async () => {
  await app.stop();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
});

// Far-future, fixed days, like the shift tests: nothing here depends on the clock. `at(hour, day)` is a UTC instant.
const at = (hour: number, day = 0) => new Date(Date.UTC(2031, 2, 4 + day, hour)).toISOString();

async function setup(shard: ShardId) {
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  const staff = await app.seedUser('Sam Staff');
  await app.addMember(teamId, staff.id, 'staff');
  const staff2 = await app.seedUser('Sofia Staff');
  await app.addMember(teamId, staff2.id, 'staff');
  const h = async (id: string) => bearer((await app.signIn(id)).accessToken);
  return { teamId, shard, owner, manager, staff, staff2, ownerH: await h(owner.id), managerH: await h(manager.id), staffH: await h(staff.id), staff2H: await h(staff2.id) };
}

type Event = { id: string; payload: { moment: string; teamId: string; recipients: string[]; title: string; body: string; shiftId?: string; swapId?: string } };
const eventsOf = async (teamId: string, shard: ShardId): Promise<Event[]> =>
  (await shards[shard].primary.$queryRaw<Event[]>`SELECT id::text AS id, payload FROM work_rows WHERE kind = 'push_event' AND payload->>'teamId' = ${teamId} ORDER BY created_at, id`);
const sorted = (ids: string[]) => [...ids].sort();

for (const shard of ['A', 'B'] as const) {
  test(`team on shard ${shard}: a shift made for someone tells that person, on the team shard, in the same transaction; never the person who made it; an open shift tells nobody`, async () => {
    const t = await setup(shard);
    const made = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Morning service', startsAt: at(8), endsAt: at(12), assignedUserId: t.staff.id }, t.managerH);
    assert.equal(made.status, 201);
    const events = await eventsOf(t.teamId, shard);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { moment: 'shift_created', teamId: t.teamId, recipients: [t.staff.id], shiftId: made.body.shift.id, ...PUSH_TEXT.shift_created });
    // A work row on the OTHER shard would mean the event was not written with the change.
    const other = (shard === 'A' ? 'B' : 'A') as ShardId;
    assert.equal((await eventsOf(t.teamId, other)).length, 0);

    const self = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Own shift', startsAt: at(8, 1), endsAt: at(12, 1), assignedUserId: t.manager.id }, t.managerH);
    const open = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Open shift', startsAt: at(8, 2), endsAt: at(12, 2) }, t.managerH);
    assert.equal(self.status, 201);
    assert.equal(open.status, 201);
    assert.equal((await eventsOf(t.teamId, shard)).length, 1, 'a manager who assigns themselves is not told, and an open shift tells nobody');
  });
}

test('a shift moved from one person to another tells both; one that only changes its note tells its person; a delete tells its person', async () => {
  const t = await setup('A');
  const made = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Evening', startsAt: at(17), endsAt: at(21), assignedUserId: t.staff.id }, t.ownerH);
  const id = made.body.shift.id as string;
  assert.equal((await app.patch(`/teams/${t.teamId}/shifts/${id}`, { assignedUserId: t.staff2.id }, t.managerH)).status, 200);
  assert.equal((await app.patch(`/teams/${t.teamId}/shifts/${id}`, { note: 'Bring the keys' }, t.managerH)).status, 200);
  assert.equal((await app.del(`/teams/${t.teamId}/shifts/${id}`, t.ownerH)).status, 204);

  const events = await eventsOf(t.teamId, 'A');
  assert.deepEqual(events.map((e) => e.payload.moment), ['shift_created', 'shift_updated', 'shift_updated', 'shift_deleted']);
  assert.deepEqual(sorted(events[1]!.payload.recipients), sorted([t.staff2.id, t.staff.id]), 'the new assignee and the one it was taken from');
  assert.deepEqual(events[2]!.payload.recipients, [t.staff2.id]);
  assert.deepEqual(events[3]!.payload.recipients, [t.staff2.id]);
  assert.ok(events.every((e) => e.payload.shiftId === id));
});

test('the event rolls back WITH the change: a refused shift writes no push event, and no activity either', async () => {
  const t = await setup('B');
  const ok = await app.post(`/teams/${t.teamId}/shifts`, { title: 'First', startsAt: at(8), endsAt: at(12), assignedUserId: t.staff.id }, t.managerH);
  assert.equal(ok.status, 201);
  const before = (await eventsOf(t.teamId, 'B')).length;
  // Overlaps the same person's shift: refused inside the transaction, after the shift row was inserted.
  const clash = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Clash', startsAt: at(10), endsAt: at(14), assignedUserId: t.staff.id }, t.managerH);
  assert.equal(clash.status, 409);
  assert.equal((await eventsOf(t.teamId, 'B')).length, before, 'nothing was queued for a change that did not happen');
});

test('the service puts the committed event on the queue after the commit, one call per row, on the team shard', async () => {
  const t = await setup('A');
  const calls: Array<{ id: string; kind: string; shard: ShardId }> = [];
  const enqueue = async (_p: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => void calls.push({ id: row.id, kind: row.kind, shard });
  const shift = await createShift(shards, { teamId: t.teamId, actorUserId: t.manager.id, shift: { title: 'Via service', startsAt: new Date(at(8, 3)), endsAt: new Date(at(12, 3)), assignedUserId: t.staff.id }, enqueue });
  await updateShift(shards, { teamId: t.teamId, shiftId: shift.id, actorUserId: t.manager.id, patch: { note: 'x' }, enqueue });
  await deleteShift(shards, { teamId: t.teamId, shiftId: shift.id, actorUserId: t.manager.id, enqueue });
  const events = await eventsOf(t.teamId, 'A');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.id), events.map((e) => e.id), 'each queued job is the committed row');
  assert.ok(calls.every((c) => c.kind === 'push_event' && c.shard === shardFor(t.teamId)));
});

async function twoShifts(t: Awaited<ReturnType<typeof setup>>) {
  const a = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Morning', startsAt: at(8, 5), endsAt: at(12, 5), assignedUserId: t.staff.id }, t.managerH);
  const b = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Evening', startsAt: at(17, 5), endsAt: at(21, 5), assignedUserId: t.staff2.id }, t.managerH);
  return { offered: a.body.shift.id as string, requested: b.body.shift.id as string };
}
const swapEvents = async (teamId: string, shard: ShardId) => (await eventsOf(teamId, shard)).filter((e) => e.payload.swapId);

test('a swap request tells the people who can decide it (never the two parties) and, in words of its own, the person asked; a repeat of the same key tells nobody twice', async () => {
  const t = await setup('A');
  const s = await twoShifts(t);
  const key = randomUUID();
  const made = await app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: s.offered, requestedShiftId: s.requested }, { ...t.staffH, 'idempotency-key': key });
  assert.equal(made.status, 201);
  const events = await swapEvents(t.teamId, 'A');
  assert.equal(events.length, 2);
  const approvers = events.find((e) => e.payload.title === PUSH_TEXT.swap_requested_approver.title)!;
  const counterparty = events.find((e) => e.payload.title === PUSH_TEXT.swap_requested_counterparty.title)!;
  assert.deepEqual(sorted(approvers.payload.recipients), sorted([t.owner.id, t.manager.id]));
  assert.deepEqual(counterparty.payload.recipients, [t.staff2.id]);
  assert.ok(events.every((e) => e.payload.moment === 'swap_requested' && e.payload.swapId === made.body.swap.id));
  assert.ok(![...approvers.payload.recipients, ...counterparty.payload.recipients].includes(t.staff.id), 'the requester is never told');

  const again = await app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: s.offered, requestedShiftId: s.requested }, { ...t.staffH, 'idempotency-key': key });
  assert.equal(again.status, 200);
  assert.equal((await swapEvents(t.teamId, 'A')).length, 2, 'the retry made no new events');
});

test('approving or rejecting a swap tells both people in it and never the manager who decided', async () => {
  const t = await setup('B');
  const s = await twoShifts(t);
  const made = await app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: s.offered, requestedShiftId: s.requested }, { ...t.staffH, 'idempotency-key': randomUUID() });
  const swapId = made.body.swap.id as string;
  assert.equal((await app.post(`/teams/${t.teamId}/swaps/${swapId}/approve`, undefined, t.managerH)).status, 200);
  const decided = (await swapEvents(t.teamId, 'B')).filter((e) => e.payload.moment === 'swap_approved');
  assert.equal(decided.length, 1);
  assert.deepEqual(sorted(decided[0]!.payload.recipients), sorted([t.staff.id, t.staff2.id]));
  assert.deepEqual({ title: decided[0]!.payload.title, body: decided[0]!.payload.body }, PUSH_TEXT.swap_approved);

  // A second swap, this one rejected, by the owner.
  const c = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Late', startsAt: at(8, 6), endsAt: at(12, 6), assignedUserId: t.staff.id }, t.managerH);
  const d = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Later', startsAt: at(17, 6), endsAt: at(21, 6), assignedUserId: t.staff2.id }, t.managerH);
  const second = await app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: c.body.shift.id, requestedShiftId: d.body.shift.id }, { ...t.staffH, 'idempotency-key': randomUUID() });
  assert.equal((await app.post(`/teams/${t.teamId}/swaps/${second.body.swap.id}/reject`, undefined, t.ownerH)).status, 200);
  const rejected = (await swapEvents(t.teamId, 'B')).filter((e) => e.payload.moment === 'swap_rejected');
  assert.equal(rejected.length, 1);
  assert.deepEqual(sorted(rejected[0]!.payload.recipients), sorted([t.staff.id, t.staff2.id]));
  assert.ok(!rejected[0]!.payload.recipients.includes(t.owner.id));
});

test('the lock-screen text of every event is generic: no shift title, no time, no name', async () => {
  const t = await setup('A');
  const s = await twoShifts(t);
  await app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: s.offered, requestedShiftId: s.requested }, { ...t.staffH, 'idempotency-key': randomUUID() });
  const all = JSON.stringify((await eventsOf(t.teamId, 'A')).map((e) => [e.payload.title, e.payload.body]));
  for (const secret of ['Morning', 'Evening', 'Sam', 'Sofia', 'Maya', 'Olive', '2031']) assert.ok(!all.includes(secret), `${secret} must not be in a notification`);
});
