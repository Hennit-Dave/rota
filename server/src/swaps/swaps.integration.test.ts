import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';

// Swaps (ADR 0023; brief requirement 2: optimistic swap requests need a server that is safe against a retried request, and requirement 4: a Staff member
// calling a manager-only endpoint directly is refused, and one team never sees another's data). The TEST shards, real Valkey, real HTTP.
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp();
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const swapsUrl = (teamId: string, id?: string, action?: string) => `/teams/${teamId}/swaps${id ? `/${id}` : ''}${action ? `/${action}` : ''}`;
const at = (hour: number, day = 0) => new Date(Date.UTC(2031, 2, 4 + day, hour)).toISOString();
const strip = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });
const key = () => ({ 'idempotency-key': randomUUID() });

async function setup(opts: { shard?: 'A' | 'B'; extraManager?: boolean } = {}) {
  const owner = await app.seedUser('Olive Owner');
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  const amara = await app.seedUser('Amara Staff');
  await app.addMember(teamId, amara.id, 'staff');
  const bola = await app.seedUser('Bola Staff');
  await app.addMember(teamId, bola.id, 'staff');
  const h = async (id: string) => bearer((await app.signIn(id)).accessToken);
  const t = { teamId, shard, owner, manager, amara, bola, ownerH: await h(owner.id), managerH: await h(manager.id), amaraH: await h(amara.id), bolaH: await h(bola.id), h };
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;

/** A shift published by the owner. */
async function shift(t: T, title: string, startHour: number, endHour: number, assignee: string | null, day = 0) {
  const res = await app.post(`/teams/${t.teamId}/shifts`, { title, startsAt: at(startHour, day), endsAt: at(endHour, day), assignedUserId: assignee }, t.ownerH);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.shift.id as string;
}

/** The usual case: Amara works the morning, Bola the evening. */
async function twoShifts(t: T) {
  return { morning: await shift(t, 'Morning service', 9, 13, t.amara.id), evening: await shift(t, 'Evening service', 17, 22, t.bola.id) };
}
const ask = (t: T, headers: Record<string, string>, offered: string, requested: string, k = key()) =>
  app.post(swapsUrl(t.teamId), { offeredShiftId: offered, requestedShiftId: requested }, { ...headers, ...k });

test('request, approve: Staff ask, a Manager approves, the two shifts change hands in one step and the feed says so', async () => {
  const t = await setup({ shard: 'B' });
  const { morning, evening } = await twoShifts(t);
  const res = await ask(t, t.amaraH, morning, evening);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const swap = res.body.swap;
  assert.equal(swap.status, 'pending');
  assert.deepEqual([swap.requester.name, swap.counterparty.name], ['Amara Staff', 'Bola Staff']);
  assert.equal(swap.offered.title, 'Morning service');
  assert.equal(swap.requested.title, 'Evening service');
  assert.deepEqual([swap.mine, swap.canCancel, swap.canDecide], [true, true, false], 'Staff may cancel their own request but not decide it');
  assert.equal(await db(t.teamId).swapRequest.count({ where: { teamId: t.teamId } }), 1);

  // The manager sees it waiting, and may decide it. Nothing has moved yet.
  const seen = await app.get(swapsUrl(t.teamId), t.managerH);
  assert.equal(seen.body.swaps.length, 1);
  assert.deepEqual([seen.body.swaps[0].mine, seen.body.swaps[0].canDecide], [false, true]);
  assert.equal((await db(t.teamId).shift.findUniqueOrThrow({ where: { id: morning } })).assignedUserId, t.amara.id);

  const ok = await app.post(swapsUrl(t.teamId, swap.id, 'approve'), undefined, t.managerH);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.swap.status, 'approved');
  assert.equal((await db(t.teamId).shift.findUniqueOrThrow({ where: { id: morning } })).assignedUserId, t.bola.id, 'the morning is now Bola\'s');
  assert.equal((await db(t.teamId).shift.findUniqueOrThrow({ where: { id: evening } })).assignedUserId, t.amara.id, 'the evening is now Amara\'s');
  const row = await db(t.teamId).swapRequest.findUniqueOrThrow({ where: { id: swap.id } });
  assert.equal(row.decidedByUserId, t.manager.id);
  assert.ok(row.decidedAt);

  // The feed has both rows; the snapshot still reads as it did when it was requested.
  const feed = await app.get(`/teams/${t.teamId}/activity`, t.amaraH);
  const kinds = (feed.body.items as Array<{ kind: string }>).map((i) => i.kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith('swap')), ['swap_approved', 'swap_requested']);
  const again = await app.get(swapsUrl(t.teamId, swap.id), t.bolaH);
  assert.equal(again.body.swap.offered.title, 'Morning service');
});

test('IDEMPOTENCY: a retried request (same key) returns the stored swap and creates nothing; five simultaneous ones create exactly one', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  const k = key();
  const first = await ask(t, t.amaraH, morning, evening, k);
  assert.equal(first.status, 201);
  const retry = await ask(t, t.amaraH, morning, evening, k);
  assert.equal(retry.status, 200, 'the stored answer, not a new request');
  assert.equal(retry.body.swap.id, first.body.swap.id);
  assert.equal(await db(t.teamId).swapRequest.count({ where: { teamId: t.teamId } }), 1);
  const otherEvening = await shift(t, 'Next evening', 17, 22, t.bola.id, 1);
  const sameKeyOtherShifts = await ask(t, t.amaraH, morning, otherEvening, k);
  assert.equal(sameKeyOtherShifts.status, 400, 'a key reused for a different request is refused, not answered with an unrelated swap');
  assert.deepEqual(sameKeyOtherShifts.body.error.details, [{ path: 'header.idempotency-key', code: 'key_reused' }]);

  // Simultaneous retries of one new request: the database lets one insert, the others get it back.
  const t2 = await setup();
  const s2 = await twoShifts(t2);
  const k2 = key();
  const results = await Promise.all(Array.from({ length: 5 }, () => ask(t2, t2.amaraH, s2.morning, s2.evening, k2)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map((r) => r.body.swap.id)).size, 1);
  assert.equal(await db(t2.teamId).swapRequest.count({ where: { teamId: t2.teamId } }), 1);
  assert.equal(await db(t2.teamId).activity.count({ where: { teamId: t2.teamId, kind: 'swap_requested' } }), 1, 'and one feed row');
});

test('a missing or malformed Idempotency-Key is a 400 before anything is read', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  for (const bad of [undefined, '', 'abc', randomUUID().toUpperCase()]) {
    const headers: Record<string, string> = { ...t.amaraH };
    if (bad !== undefined) headers['idempotency-key'] = bad;
    const res = await app.post(swapsUrl(t.teamId), { offeredShiftId: morning, requestedShiftId: evening }, headers);
    assert.equal(res.status, 400, String(bad));
    assert.deepEqual(res.body.error.details, [{ path: 'header.idempotency-key', code: 'invalid' }]);
  }
  assert.equal(await db(t.teamId).swapRequest.count({ where: { teamId: t.teamId } }), 0);
});

test('validation: the whole request is checked; the caller and the other person are never taken from the request', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  // Unknown or extra fields, wrong types.
  for (const body of [{}, { offeredShiftId: morning }, { offeredShiftId: 'x', requestedShiftId: evening }, { offeredShiftId: morning, requestedShiftId: evening, requesterUserId: t.bola.id }, { offeredShiftId: morning, requestedShiftId: evening, status: 'approved' }]) {
    const res = await app.post(swapsUrl(t.teamId), body, { ...t.amaraH, ...key() });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'validation_failed');
  }
  assert.equal((await app.post(swapsUrl('not-a-uuid'), {}, { ...t.amaraH, ...key() })).status, 400);
  assert.equal((await app.get(swapsUrl(t.teamId, 'nope'), t.amaraH)).status, 400);
  assert.equal(await db(t.teamId).swapRequest.count({ where: { teamId: t.teamId } }), 0);
});

test('eligibility: only your own shift can be offered; the other side must be a teammate\'s assigned shift; neither may have started; a shift cannot be in two swaps', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  const open = await shift(t, 'Open shift', 14, 16, null);
  const mine2 = await shift(t, 'Amara again', 14, 16, t.amara.id, 1);
  const detail = (r: { body: { error: { details: unknown } } }) => r.body.error.details;

  // Offering Bola's shift for Amara's own: wrong on both sides (not yours to give; and the other side is your own shift).
  assert.deepEqual(detail(await ask(t, t.amaraH, evening, morning)), [{ path: 'offeredShiftId', code: 'not_yours' }, { path: 'requestedShiftId', code: 'not_swappable' }], "offering someone else's shift");
  assert.deepEqual(detail(await ask(t, t.amaraH, morning, open)), [{ path: 'requestedShiftId', code: 'not_swappable' }], 'an open shift');
  assert.deepEqual(detail(await ask(t, t.amaraH, morning, mine2)), [{ path: 'requestedShiftId', code: 'not_swappable' }], 'your own other shift');
  assert.deepEqual(detail(await ask(t, t.amaraH, morning, morning)), [{ path: 'requestedShiftId', code: 'not_swappable' }], 'the same shift on both sides');

  // A shift that has started.
  const past = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Yesterday', startsAt: '2020-01-01T09:00:00.000Z', endsAt: '2020-01-01T17:00:00.000Z', assignedUserId: t.amara.id }, t.ownerH);
  assert.deepEqual(detail(await ask(t, t.amaraH, past.body.shift.id, evening)), [{ path: 'offeredShiftId', code: 'in_past' }]);

  // Another team's shift, and one that does not exist, read exactly like an open one: nothing is revealed.
  const other = await setup();
  const foreign = await shift(other, 'Elsewhere', 9, 13, other.bola.id);
  const a = await ask(t, t.amaraH, morning, foreign);
  const b = await ask(t, t.amaraH, morning, randomUUID());
  assert.equal(a.status, 400);
  assert.deepEqual(strip(a), strip(b));
  assert.deepEqual(detail(a), [{ path: 'requestedShiftId', code: 'not_swappable' }]);

  // A shift already in a waiting swap cannot be put in another.
  assert.equal((await ask(t, t.amaraH, morning, evening)).status, 201);
  const busy = await ask(t, t.bolaH, evening, morning);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'swap_not_possible');
  assert.deepEqual(busy.body.error.details, [{ path: 'swap', code: 'already_in_swap' }]);
});

test('a swap that would double-book either person is refused at the request, and again at approval if the schedule changed in between', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t); // Amara 09-13, Bola 17-22
  await shift(t, 'Amara noon', 16, 18, t.amara.id); // Amara would receive 17-22 while on 16-18
  const clash = await ask(t, t.amaraH, morning, evening);
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.body.error.details, [{ path: 'swap', code: 'would_double_book' }]);

  // A swap that is fine today, then Bola is given a clashing shift before the manager decides.
  const t2 = await setup();
  const s2 = await twoShifts(t2);
  const made = await ask(t2, t2.amaraH, s2.morning, s2.evening);
  assert.equal(made.status, 201);
  await shift(t2, 'Bola morning', 11, 12, t2.bola.id); // Bola would receive 09-13
  const refused = await app.post(swapsUrl(t2.teamId, made.body.swap.id, 'approve'), undefined, t2.managerH);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'swap_not_possible');
  assert.equal((await db(t2.teamId).shift.findUniqueOrThrow({ where: { id: s2.morning } })).assignedUserId, t2.amara.id, 'nothing moved');
  assert.equal((await db(t2.teamId).swapRequest.findUniqueOrThrow({ where: { id: made.body.swap.id } })).status, 'pending', 'it stays pending so a manager can reject it');
  assert.equal((await app.post(swapsUrl(t2.teamId, made.body.swap.id, 'reject'), undefined, t2.managerH)).status, 200);
});

test('STALE REQUESTS: a shift that changed hands, was moved, or was deleted since the request makes the approval fail, and nothing moves', async () => {
  const cases: Array<{ name: string; change: (t: T, s: { morning: string; evening: string }) => Promise<unknown> }> = [
    { name: 'reassigned', change: (t, s) => app.patch(`/teams/${t.teamId}/shifts/${s.morning}`, { assignedUserId: t.manager.id }, t.ownerH) },
    { name: 'rescheduled', change: (t, s) => app.patch(`/teams/${t.teamId}/shifts/${s.evening}`, { startsAt: at(18), endsAt: at(22) }, t.ownerH) },
    { name: 'deleted', change: (t, s) => app.del(`/teams/${t.teamId}/shifts/${s.evening}`, t.ownerH) },
    { name: 'someone left the team', change: (t) => db(t.teamId).membership.deleteMany({ where: { teamId: t.teamId, userId: t.bola.id } }) },
  ];
  for (const c of cases) {
    const t = await setup();
    const s = await twoShifts(t);
    const made = await ask(t, t.amaraH, s.morning, s.evening);
    assert.equal(made.status, 201, c.name);
    await c.change(t, s);
    const res = await app.post(swapsUrl(t.teamId, made.body.swap.id, 'approve'), undefined, t.managerH);
    assert.equal(res.status, 409, c.name);
    assert.equal(res.body.error.code, 'swap_not_possible', c.name);
    assert.equal((await db(t.teamId).swapRequest.findUniqueOrThrow({ where: { id: made.body.swap.id } })).status, 'pending', `${c.name}: still pending`);
  }
});

test('a shift that has already started cannot be swapped at approval either', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  const made = await ask(t, t.amaraH, morning, evening);
  // Approve "from the future": the same call a day after the shifts began.
  const { decideSwap } = await import('./service.js');
  await assert.rejects(
    decideSwap(app.raw, { teamId: t.teamId, swapId: made.body.swap.id, caller: { userId: t.manager.id, role: 'manager' }, decision: 'approve', now: new Date(Date.UTC(2031, 2, 5)) }),
    (e: { code?: string }) => e.code === 'swap_not_possible',
  );
});

test('THE SECURITY TEST: a Staff member cannot approve or reject, whoever they are in the swap, and nothing changes', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  const made = await ask(t, t.amaraH, morning, evening);
  const id = made.body.swap.id as string;
  for (const [who, headers] of [['the requester', t.amaraH], ['the other person', t.bolaH]] as const) {
    for (const action of ['approve', 'reject']) {
      const res = await app.post(swapsUrl(t.teamId, id, action), undefined, headers);
      assert.equal(res.status, 403, `${who} ${action}`);
      assert.equal(res.body.error.code, 'forbidden');
    }
  }
  assert.equal((await db(t.teamId).swapRequest.findUniqueOrThrow({ where: { id } })).status, 'pending');
  assert.equal((await db(t.teamId).shift.findUniqueOrThrow({ where: { id: morning } })).assignedUserId, t.amara.id);
  assert.equal(await db(t.teamId).activity.count({ where: { teamId: t.teamId, kind: { in: ['swap_approved', 'swap_rejected'] } } }), 0, 'and nothing was recorded');
});

test('A PARTY CANNOT DECIDE THEIR OWN SWAP: a Manager never; the Owner only when there is no other Owner or Manager', async () => {
  const t = await setup();
  const mgrShift = await shift(t, 'Manager shift', 9, 13, t.manager.id);
  const bolaShift = await shift(t, 'Evening service', 17, 22, t.bola.id);
  const made = await ask(t, t.managerH, mgrShift, bolaShift); // the Manager asks (any role may)
  assert.equal(made.status, 201);
  assert.equal(made.body.swap.canDecide, false);
  const own = await app.post(swapsUrl(t.teamId, made.body.swap.id, 'approve'), undefined, t.managerH);
  assert.equal(own.status, 403, 'a Manager cannot approve a swap they are in');
  const byOwner = await app.get(swapsUrl(t.teamId), t.ownerH);
  assert.equal(byOwner.body.swaps[0].canDecide, true, 'the server says the Owner may');
  assert.equal((await app.post(swapsUrl(t.teamId, made.body.swap.id, 'approve'), undefined, t.ownerH)).status, 200);

  // An Owner in the swap, with a Manager on the team: the Manager decides, the Owner may not.
  const t2 = await setup();
  const ownerShift = await shift(t2, 'Owner shift', 9, 13, t2.owner.id);
  const amaraShift = await shift(t2, 'Amara shift', 17, 22, t2.amara.id);
  const ownerAsks = await ask(t2, t2.ownerH, ownerShift, amaraShift);
  assert.equal((await app.post(swapsUrl(t2.teamId, ownerAsks.body.swap.id, 'approve'), undefined, t2.ownerH)).status, 403);
  assert.equal((await app.post(swapsUrl(t2.teamId, ownerAsks.body.swap.id, 'approve'), undefined, t2.managerH)).status, 200);

  // The Owner is the only one who could decide: they may.
  const t3 = await setup();
  await db(t3.teamId).membership.deleteMany({ where: { teamId: t3.teamId, userId: t3.manager.id } });
  const o3 = await shift(t3, 'Owner shift', 9, 13, t3.owner.id);
  const a3 = await shift(t3, 'Amara shift', 17, 22, t3.amara.id);
  const asks3 = await ask(t3, t3.ownerH, o3, a3);
  assert.equal(asks3.body.swap.canDecide, true);
  assert.equal((await app.post(swapsUrl(t3.teamId, asks3.body.swap.id, 'approve'), undefined, t3.ownerH)).status, 200);
});

test('reject: nothing moves, the request is rejected and recorded; a decided request cannot be decided again; two simultaneous approvals give one winner', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  const made = await ask(t, t.amaraH, morning, evening);
  const id = made.body.swap.id as string;
  const rej = await app.post(swapsUrl(t.teamId, id, 'reject'), undefined, t.managerH);
  assert.equal(rej.body.swap.status, 'rejected');
  assert.equal((await db(t.teamId).shift.findUniqueOrThrow({ where: { id: morning } })).assignedUserId, t.amara.id);
  assert.equal(await db(t.teamId).activity.count({ where: { teamId: t.teamId, kind: 'swap_rejected' } }), 1);
  for (const action of ['approve', 'reject']) {
    const again = await app.post(swapsUrl(t.teamId, id, action), undefined, t.managerH);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'swap_not_pending');
  }

  const t2 = await setup();
  const s2 = await twoShifts(t2);
  const made2 = await ask(t2, t2.amaraH, s2.morning, s2.evening);
  const both = await Promise.all([app.post(swapsUrl(t2.teamId, made2.body.swap.id, 'approve'), undefined, t2.managerH), app.post(swapsUrl(t2.teamId, made2.body.swap.id, 'approve'), undefined, t2.ownerH)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await db(t2.teamId).activity.count({ where: { teamId: t2.teamId, kind: 'swap_approved' } }), 1, 'decided once');
  assert.equal((await db(t2.teamId).shift.findUniqueOrThrow({ where: { id: s2.morning } })).assignedUserId, t2.bola.id, 'swapped once, not back again');
});

test('cancel: only the requester, only while waiting; a decision that landed first wins', async () => {
  const t = await setup();
  const { morning, evening } = await twoShifts(t);
  const made = await ask(t, t.amaraH, morning, evening);
  const id = made.body.swap.id as string;
  assert.equal((await app.post(swapsUrl(t.teamId, id, 'cancel'), undefined, t.bolaH)).status, 403, 'the other person cannot cancel it');
  assert.equal((await app.post(swapsUrl(t.teamId, id, 'cancel'), undefined, t.managerH)).status, 403, 'nor can a manager (they reject)');
  const ok = await app.post(swapsUrl(t.teamId, id, 'cancel'), undefined, t.amaraH);
  assert.equal(ok.body.swap.status, 'cancelled');
  assert.equal((await app.post(swapsUrl(t.teamId, id, 'cancel'), undefined, t.amaraH)).status, 409);
  assert.equal((await app.post(swapsUrl(t.teamId, id, 'approve'), undefined, t.managerH)).status, 409, 'a cancelled request cannot be approved');
  // The shifts are free again: the same shifts can be asked for again with a new key.
  assert.equal((await ask(t, t.amaraH, morning, evening)).status, 201);
});

test('LIMITS: at most 3 waiting per person (the 4th is 409 swap_limit_reached), and a retry of an existing request is still answered', async () => {
  const t = await setup();
  const mine = [await shift(t, 'A1', 9, 10, t.amara.id), await shift(t, 'A2', 9, 10, t.amara.id, 1), await shift(t, 'A3', 9, 10, t.amara.id, 2), await shift(t, 'A4', 9, 10, t.amara.id, 3)];
  const theirs = [await shift(t, 'B1', 12, 13, t.bola.id), await shift(t, 'B2', 12, 13, t.bola.id, 1), await shift(t, 'B3', 12, 13, t.bola.id, 2), await shift(t, 'B4', 12, 13, t.bola.id, 3)];
  const keys = [key(), key(), key()];
  for (let i = 0; i < 3; i++) assert.equal((await ask(t, t.amaraH, mine[i]!, theirs[i]!, keys[i])).status, 201);
  const fourth = await ask(t, t.amaraH, mine[3]!, theirs[3]!);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'swap_limit_reached');
  assert.equal((await ask(t, t.amaraH, mine[0]!, theirs[0]!, keys[0])).status, 200, 'a retry of the first is the stored answer, not a new request');
  // Withdrawing one makes room.
  const list = await app.get(swapsUrl(t.teamId), t.amaraH);
  await app.post(swapsUrl(t.teamId, list.body.swaps[0].id, 'cancel'), undefined, t.amaraH);
  assert.equal((await ask(t, t.amaraH, mine[3]!, theirs[3]!)).status, 201);
});

test('SIMULTANEOUS requests from one person for different swaps never exceed the limit of 3: with two slots used, three at once give exactly one more', async () => {
  const t = await setup();
  const ids: Array<[string, string]> = [];
  for (let i = 0; i < 5; i++) ids.push([await shift(t, `A${i}`, 9, 10, t.amara.id, i), await shift(t, `B${i}`, 12, 13, t.bola.id, i)]);
  assert.equal((await ask(t, t.amaraH, ids[0]![0], ids[0]![1])).status, 201);
  assert.equal((await ask(t, t.amaraH, ids[1]![0], ids[1]![1])).status, 201);
  // Three at once is as many as the test database's connection pool (3) can hold; they queue on the requester's membership row, one after the other.
  const results = await Promise.all(ids.slice(2).map(([o, r]) => ask(t, t.amaraH, o, r)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'swap_limit_reached'));
  assert.equal(await db(t.teamId).swapRequest.count({ where: { teamId: t.teamId, status: 'pending' } }), 3);
});

test('the swap request is limited to 10 per user per hour (chosen, not measured): the next is 429 with Retry-After; another user is unaffected', async () => {
  const limited = await startTeamsTestApp({ rateLimits: { swapRequestUser: { max: 2, windowSeconds: 60 } } });
  try {
    assert.deepEqual(app.config.rateLimits.swapRequestUser, { max: 10, windowSeconds: 3600 }, 'the shipped default');
    const owner = await limited.seedUser('Limit Owner');
    const { teamId } = await limited.seedTeam({ ownerId: owner.id });
    const a = await limited.seedUser('A');
    const b = await limited.seedUser('B');
    await limited.addMember(teamId, a.id, 'staff');
    await limited.addMember(teamId, b.id, 'staff');
    const oh = bearer((await limited.signIn(owner.id)).accessToken);
    const ah = bearer((await limited.signIn(a.id)).accessToken);
    const bh = bearer((await limited.signIn(b.id)).accessToken);
    const mk = async (title: string, who: string, day: number) =>
      (await limited.post(`/teams/${teamId}/shifts`, { title, startsAt: at(9, day), endsAt: at(10, day), assignedUserId: who }, oh)).body.shift.id as string;
    const mineA = [await mk('a1', a.id, 0), await mk('a2', a.id, 1), await mk('a3', a.id, 2)];
    const theirsB = [await mk('b1', b.id, 0), await mk('b2', b.id, 1), await mk('b3', b.id, 2)];
    const go = (i: number) => limited.post(swapsUrl(teamId), { offeredShiftId: mineA[i], requestedShiftId: theirsB[i] }, { ...ah, ...key() });
    assert.equal((await go(0)).status, 201);
    assert.equal((await go(1)).status, 201);
    const third = await go(2);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.equal(await limited.raw[shardFor(teamId)].primary.swapRequest.count({ where: { teamId } }), 2, 'the blocked request wrote nothing');
    // Per user: B can still ask; reading is not limited.
    assert.equal((await limited.post(swapsUrl(teamId), { offeredShiftId: theirsB[2], requestedShiftId: mineA[2] }, { ...bh, ...key() })).status, 201);
    assert.equal((await limited.get(swapsUrl(teamId), ah)).status, 200);
  } finally {
    await limited.stop();
  }
});

test('with Valkey down the swap request fails CLOSED: 503 and nothing is written; reading does not need Valkey', async () => {
  const dead = await startTeamsTestApp({ deadValkey: true });
  try {
    const owner = await dead.seedUser('Dead Owner');
    const { teamId } = await dead.seedTeam({ ownerId: owner.id });
    const a = await dead.seedUser('A');
    await dead.addMember(teamId, a.id, 'staff');
    const ah = bearer((await dead.signIn(a.id)).accessToken);
    const res = await dead.post(swapsUrl(teamId), { offeredShiftId: randomUUID(), requestedShiftId: randomUUID() }, { ...ah, ...key() });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(await dead.raw[shardFor(teamId)].primary.swapRequest.count({ where: { teamId } }), 0);
    assert.equal((await dead.get(swapsUrl(teamId), ah)).status, 200);
  } finally {
    await dead.stop();
  }
});

test("TEAM ISOLATION across shards: another team's swaps read as 'not found', identical to unknown ones, on every route; strangers and no token are refused", async () => {
  const x = await setup({ shard: 'A' });
  const y = await setup({ shard: 'B' });
  const sy = await twoShifts(y);
  const swapY = (await ask(y, y.amaraH, sy.morning, sy.evening)).body.swap.id as string;
  const unknown = randomUUID();

  const probes: Array<[string, () => Promise<{ status: number; body: { error: Record<string, unknown> } }>, () => Promise<{ status: number; body: { error: Record<string, unknown> } }>]> = [
    ['list', () => app.get(swapsUrl(y.teamId), x.amaraH), () => app.get(swapsUrl(unknown), x.amaraH)],
    ['get', () => app.get(swapsUrl(y.teamId, swapY), x.ownerH), () => app.get(swapsUrl(unknown, swapY), x.ownerH)],
    ['create', () => app.post(swapsUrl(y.teamId), { offeredShiftId: sy.morning, requestedShiftId: sy.evening }, { ...x.amaraH, ...key() }), () => app.post(swapsUrl(unknown), { offeredShiftId: sy.morning, requestedShiftId: sy.evening }, { ...x.amaraH, ...key() })],
    ['approve', () => app.post(swapsUrl(y.teamId, swapY, 'approve'), undefined, x.ownerH), () => app.post(swapsUrl(unknown, swapY, 'approve'), undefined, x.ownerH)],
    ['cancel', () => app.post(swapsUrl(y.teamId, swapY, 'cancel'), undefined, x.amaraH), () => app.post(swapsUrl(unknown, swapY, 'cancel'), undefined, x.amaraH)],
  ];
  for (const [name, real, fake] of probes) {
    const r = await real();
    assert.equal(r.status, 404, name);
    assert.deepEqual(strip(r), strip(await fake()), `${name}: byte-identical to an unknown team`);
  }
  // A swap ID from another team under MY team's path is just not found, whatever my role.
  assert.equal((await app.get(swapsUrl(x.teamId, swapY), x.ownerH)).status, 404);
  assert.equal((await app.post(swapsUrl(x.teamId, swapY, 'approve'), undefined, x.ownerH)).status, 404);
  assert.equal((await app.get(swapsUrl(y.teamId))).status, 401);
  assert.equal((await db(y.teamId).swapRequest.findUniqueOrThrow({ where: { id: swapY } })).status, 'pending', 'and nothing of Y changed');
});

test('who sees what: Staff see only their own swaps (as either side); a Manager also sees every waiting request, and not other people\'s finished ones', async () => {
  const t = await setup();
  const carol = await app.seedUser('Carol Staff');
  await app.addMember(t.teamId, carol.id, 'staff');
  const carolH = bearer((await app.signIn(carol.id)).accessToken);
  const { morning, evening } = await twoShifts(t);
  const c1 = await shift(t, 'Carol 1', 9, 13, carol.id, 1);
  const a2 = await shift(t, 'Amara 2', 9, 13, t.amara.id, 2);
  await ask(t, t.amaraH, morning, evening); // Amara <-> Bola, waiting
  const second = await ask(t, carolH, c1, a2); // Carol <-> Amara, waiting
  const names = (r: { body: { swaps: Array<{ requester: { name: string } }> } }) => r.body.swaps.map((s) => s.requester.name).sort();
  assert.deepEqual(names(await app.get(swapsUrl(t.teamId), t.amaraH)), ['Amara Staff', 'Carol Staff'], 'Amara is on both');
  assert.deepEqual(names(await app.get(swapsUrl(t.teamId), t.bolaH)), ['Amara Staff'], 'Bola only the one he is in');
  assert.deepEqual(names(await app.get(swapsUrl(t.teamId), carolH)), ['Carol Staff']);
  assert.deepEqual(names(await app.get(swapsUrl(t.teamId), t.managerH)), ['Amara Staff', 'Carol Staff'], 'a manager sees every waiting one');
  // Once decided, a swap between other people leaves the manager's list; the two people still have it.
  await app.post(swapsUrl(t.teamId, second.body.swap.id, 'reject'), undefined, t.ownerH);
  assert.deepEqual(names(await app.get(swapsUrl(t.teamId), t.managerH)), ['Amara Staff']);
  assert.deepEqual(names(await app.get(swapsUrl(t.teamId), carolH)), ['Carol Staff']);
  // Bola cannot read Carol's swap by ID.
  assert.equal((await app.get(swapsUrl(t.teamId, second.body.swap.id), t.bolaH)).status, 404);
});

test('a removed member loses swaps on the very next request (the role is read from the database, not the token)', async () => {
  const t = await setup();
  assert.equal((await app.get(swapsUrl(t.teamId), t.amaraH)).status, 200);
  await db(t.teamId).membership.deleteMany({ where: { teamId: t.teamId, userId: t.amara.id } });
  assert.equal((await app.get(swapsUrl(t.teamId), t.amaraH)).status, 404);
});
