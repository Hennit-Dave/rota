import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';

// Shifts and the activity they write (ADR 0021; brief requirements 4: "a Staff user calling the delete-shift endpoint directly is rejected" and
// "one team never sees another team's data", both with a test). The TEST shards, real Valkey, real HTTP.
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp();
});
after(() => app.stop());

// Far-future, fixed days: nothing here depends on the clock. `at(hour, dayOffset)` is a UTC instant.
const at = (hour: number, day = 0, minute = 0) => new Date(Date.UTC(2031, 2, 4 + day, hour, minute)).toISOString();
const strip = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });

async function setup(opts: { shard?: 'A' | 'B' } = {}) {
  const owner = await app.seedUser('Olive Owner');
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  const staff = await app.seedUser('Sam Staff');
  await app.addMember(teamId, staff.id, 'staff');
  const staff2 = await app.seedUser('Sofia Staff');
  await app.addMember(teamId, staff2.id, 'staff');
  const h = async (id: string) => bearer((await app.signIn(id)).accessToken);
  return {
    teamId,
    shard,
    owner,
    manager,
    staff,
    staff2,
    ownerH: await h(owner.id),
    managerH: await h(manager.id),
    staffH: await h(staff.id),
    staff2H: await h(staff2.id),
    h,
  };
}

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const shiftsUrl = (teamId: string, id?: string) => `/teams/${teamId}/shifts${id ? `/${id}` : ''}`;
const body = (extra: Record<string, unknown> = {}) => ({ title: 'Morning service', startsAt: at(9), endsAt: at(17), ...extra });

test('create: a Manager publishes a shift; the shift and its activity row commit together, and times keep millisecond precision', async () => {
  const t = await setup({ shard: 'B' });
  const res = await app.post(shiftsUrl(t.teamId), body({ area: 'Front of house', breakMinutes: 30, note: 'Briefing at 08:45', assignedUserId: t.staff.id, startsAt: '2031-03-04T09:00:00.123Z' }), t.managerH);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const s = res.body.shift;
  assert.deepEqual(
    { title: s.title, area: s.area, breakMinutes: s.breakMinutes, note: s.note, status: s.status, assignee: s.assignee },
    { title: 'Morning service', area: 'Front of house', breakMinutes: 30, note: 'Briefing at 08:45', status: 'scheduled', assignee: { id: t.staff.id, name: 'Sam Staff' } },
  );
  assert.equal(s.startsAt, '2031-03-04T09:00:00.123Z', 'the millisecond survives the round trip');

  // The SQL evidence: the row is on the TEAM'S shard (and only there), and so is its activity row, written by the same request.
  const other = t.shard === 'A' ? 'B' : 'A';
  assert.equal(await app.raw[other].primary.shift.count({ where: { id: s.id } }), 0);
  const row = await db(t.teamId).shift.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(row.teamId, t.teamId);
  assert.equal(row.createdByUserId, t.manager.id);
  assert.equal(row.startsAt.getTime(), Date.parse('2031-03-04T09:00:00.123Z'));
  const activity = await db(t.teamId).activity.findMany({ where: { teamId: t.teamId, shiftId: s.id } });
  assert.equal(activity.length, 1);
  assert.equal(activity[0]!.kind, 'shift_created');
  assert.equal(activity[0]!.actorUserId, t.manager.id);
  assert.deepEqual(activity[0]!.data, { title: 'Morning service', startsAt: '2031-03-04T09:00:00.123Z', endsAt: at(17), assignedUserId: t.staff.id });
});

test('THE BRIEF: a Staff member calling delete-shift directly is rejected with 403, and the shift and its history are untouched', async () => {
  const t = await setup();
  const created = await app.post(shiftsUrl(t.teamId), body({ assignedUserId: t.staff.id }), t.managerH);
  const id = created.body.shift.id as string;

  const denied = await app.del(shiftsUrl(t.teamId, id), t.staffH);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
  assert.equal(await db(t.teamId).shift.count({ where: { id } }), 1, 'the shift still exists');
  assert.equal(await db(t.teamId).activity.count({ where: { shiftId: id, kind: 'shift_deleted' } }), 0, 'and nothing was recorded');

  // Owner and Manager may. The activity row survives the shift and keeps its snapshot.
  const ok = await app.del(shiftsUrl(t.teamId, id), t.managerH);
  assert.equal(ok.status, 204);
  assert.equal(await db(t.teamId).shift.count({ where: { id } }), 0);
  const gone = await db(t.teamId).activity.findMany({ where: { shiftId: id, kind: 'shift_deleted' } });
  assert.equal(gone.length, 1);
  assert.equal((gone[0]!.data as { title: string }).title, 'Morning service');
  assert.equal(await db(t.teamId).activity.count({ where: { shiftId: id } }), 2, 'created and deleted both remain after the shift is gone');
});

test('a Staff member can view the schedule but cannot publish or change a shift (403 each, nothing written)', async () => {
  const t = await setup();
  const created = await app.post(shiftsUrl(t.teamId), body(), t.ownerH);
  const id = created.body.shift.id as string;
  const q = `?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(0, 7))}`;

  assert.equal((await app.get(shiftsUrl(t.teamId) + q, t.staffH)).status, 200);
  const before = await db(t.teamId).activity.count({ where: { teamId: t.teamId } });
  assert.equal((await app.post(shiftsUrl(t.teamId), body({ title: 'Sneaky' }), t.staffH)).status, 403);
  assert.equal((await app.patch(shiftsUrl(t.teamId, id), { title: 'Changed' }, t.staffH)).status, 403);
  assert.equal(await db(t.teamId).shift.count({ where: { teamId: t.teamId } }), 1);
  assert.equal((await db(t.teamId).shift.findUniqueOrThrow({ where: { id } })).title, 'Morning service');
  assert.equal(await db(t.teamId).activity.count({ where: { teamId: t.teamId } }), before);
});

test('ROLE FROM THE SERVER: a Manager demoted to Staff is refused on the very next request with the same token', async () => {
  const t = await setup();
  assert.equal((await app.post(shiftsUrl(t.teamId), body(), t.managerH)).status, 201);
  await app.setRole(t.teamId, t.manager.id, 'staff');
  assert.equal((await app.post(shiftsUrl(t.teamId), body({ startsAt: at(9, 1), endsAt: at(17, 1) }), t.managerH)).status, 403);
});

test('TEAM ISOLATION across shards: a member of team X gets the same 404 for team Y (list, create, update, delete) as for a team that does not exist', async () => {
  const x = await setup({ shard: 'A' });
  const y = await setup({ shard: 'B' });
  const yShift = (await app.post(shiftsUrl(y.teamId), body(), y.ownerH)).body.shift.id as string;
  const q = `?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(0, 7))}`;
  const ghost = randomUUID();

  for (const [label, call] of [
    ['list', (id: string) => app.get(shiftsUrl(id) + q, x.ownerH)],
    ['create', (id: string) => app.post(shiftsUrl(id), body(), x.ownerH)],
    ['update', (id: string) => app.patch(shiftsUrl(id, yShift), { title: 'Hijack' }, x.ownerH)],
    ['delete', (id: string) => app.del(shiftsUrl(id, yShift), x.ownerH)],
  ] as const) {
    const foreign = await call(y.teamId);
    const unknown = await call(ghost);
    assert.equal(foreign.status, 404, `${label} on another team`);
    assert.deepEqual(strip(foreign), strip(unknown), `${label}: identical to a team that does not exist`);
  }
  // And the other direction, and nothing of Y changed.
  assert.equal((await app.get(shiftsUrl(x.teamId) + q, y.ownerH)).status, 404);
  assert.equal((await db(y.teamId).shift.findUniqueOrThrow({ where: { id: yShift } })).title, 'Morning service');
});

test("a shift ID from ANOTHER team is not found under MY team's path (404), whatever the caller's role", async () => {
  const x = await setup({ shard: 'A' });
  const y = await setup({ shard: 'A' }); // the same shard on purpose: only the team_id filter keeps them apart
  const yShift = (await app.post(shiftsUrl(y.teamId), body(), y.ownerH)).body.shift.id as string;

  assert.equal((await app.patch(shiftsUrl(x.teamId, yShift), { title: 'Hijack' }, x.ownerH)).status, 404);
  assert.equal((await app.del(shiftsUrl(x.teamId, yShift), x.ownerH)).status, 404);
  assert.equal((await db(y.teamId).shift.findUniqueOrThrow({ where: { id: yShift } })).title, 'Morning service', 'untouched');
  assert.equal(await db(y.teamId).activity.count({ where: { shiftId: yShift } }), 1, 'and no activity was written for the attempts');
});

test('list: a shift is returned when it overlaps [from, to); one that only touches the edge is not; soonest first; names come with it', async () => {
  const t = await setup();
  const mk = async (b: Record<string, unknown>) => (await app.post(shiftsUrl(t.teamId), b, t.ownerH)).body.shift.id as string;
  const before = await mk({ title: 'Ends exactly at from', startsAt: at(1), endsAt: at(9) });
  const inside2 = await mk({ title: 'Second', startsAt: at(12), endsAt: at(14), assignedUserId: t.staff.id });
  const inside1 = await mk({ title: 'First', startsAt: at(10), endsAt: at(11) });
  const straddle = await mk({ title: 'Straddles to', startsAt: at(16), endsAt: at(20) });
  const after = await mk({ title: 'Starts exactly at to', startsAt: at(18), endsAt: at(22) });
  assert.ok(before && after);

  const res = await app.get(`${shiftsUrl(t.teamId)}?from=${encodeURIComponent(at(9))}&to=${encodeURIComponent(at(18))}`, t.staffH);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.shifts.map((s: { id: string }) => s.id), [inside1, inside2, straddle], 'overlap rule, soonest first');
  assert.deepEqual(res.body.shifts[1].assignee, { id: t.staff.id, name: 'Sam Staff' });
  assert.equal(res.body.shifts[0].assignee, null, 'an open shift has no assignee');

  const mine = await app.get(`${shiftsUrl(t.teamId)}?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(0, 1))}&mine=true`, t.staffH);
  assert.deepEqual(mine.body.shifts.map((s: { id: string }) => s.id), [inside2], 'mine=true is only the caller\'s shifts');
});

test('validation: the whole request is checked and nothing is written (400, no input echoed)', async () => {
  const t = await setup();
  const url = shiftsUrl(t.teamId);
  const count = () => db(t.teamId).shift.count({ where: { teamId: t.teamId } });
  const ok = body();
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ['unknown key', { ...ok, extra: 1 }, '', 'unrecognized_key'],
    ['empty title', { ...ok, title: '   ' }, 'title', 'too_short'],
    ['title too long', { ...ok, title: 'x'.repeat(101) }, 'title', 'too_long'],
    ['note too long', { ...ok, note: 'x'.repeat(501) }, 'note', 'too_long'],
    ['a local time with no offset', { ...ok, startsAt: '2031-03-04T09:00:00' }, 'startsAt', 'invalid_format'],
    ['not a date', { ...ok, endsAt: 'tomorrow' }, 'endsAt', 'invalid_format'],
    ['end before start', { ...ok, startsAt: at(17), endsAt: at(9) }, 'endsAt', 'must_be_after_start'],
    ['end equal to start', { ...ok, startsAt: at(9), endsAt: at(9) }, 'endsAt', 'must_be_after_start'],
    ['break longer than the shift', { ...ok, startsAt: at(9), endsAt: at(10), breakMinutes: 61 }, 'breakMinutes', 'break_too_long'],
    ['negative break', { ...ok, breakMinutes: -1 }, 'breakMinutes', 'too_short'],
    ['assignee not a UUID', { ...ok, assignedUserId: 'sam' }, 'assignedUserId', 'invalid_format'],
  ];
  for (const [label, b, path, code] of cases) {
    const r = await app.post(url, b, t.managerH);
    assert.equal(r.status, 400, label);
    assert.equal(r.body.error.code, 'validation_failed', label);
    assert.ok(r.body.error.details.some((d: { path: string; code: string }) => d.path === path && d.code === code), `${label}: ${JSON.stringify(r.body.error.details)}`);
    assert.equal(JSON.stringify(r.body).includes('tomorrow'), false, `${label}: input is not echoed back`);
  }
  assert.equal(await count(), 0);

  // A break exactly as long as the shift is allowed (the ceiling is the shift's own length).
  assert.equal((await app.post(url, { ...ok, startsAt: at(9), endsAt: at(10), breakMinutes: 60 }, t.managerH)).status, 201);
  // Params and query: a non-UUID team or shift, and every malformed calendar range.
  assert.equal((await app.get(`/teams/not-a-uuid/shifts?from=${at(0)}&to=${at(1)}`, t.managerH)).status, 400);
  assert.equal((await app.patch(shiftsUrl(t.teamId, 'nope'), { title: 'x' }, t.managerH)).status, 400);
  assert.equal((await app.del(shiftsUrl(t.teamId, 'nope'), t.managerH)).status, 400);
  const q = (qs: string) => app.get(`${url}?${qs}`, t.managerH);
  const E = encodeURIComponent;
  assert.equal((await q('')).status, 400, 'from and to are required');
  assert.equal((await q(`from=${E(at(0))}`)).status, 400);
  assert.equal((await q(`from=${E(at(0))}&to=${E(at(0))}`)).status, 400, 'to must be after from');
  assert.equal((await q(`from=${E(at(0))}&to=${E(at(0, 1))}&mine=maybe`)).status, 400);
  assert.equal((await q(`from=${E(at(0))}&to=${E(at(0, 1))}&limit=5`)).status, 400, 'an unknown query key is refused');
});

test('the calendar range is capped at 42 days (approved): 42 days is accepted, 42 days and a millisecond is refused', async () => {
  const t = await setup();
  const E = encodeURIComponent;
  const from = '2031-03-04T00:00:00.000Z';
  const exactly = '2031-04-15T00:00:00.000Z'; // 42 days later
  const over = '2031-04-15T00:00:00.001Z';
  assert.equal((await app.get(`${shiftsUrl(t.teamId)}?from=${E(from)}&to=${E(exactly)}`, t.staffH)).status, 200);
  const r = await app.get(`${shiftsUrl(t.teamId)}?from=${E(from)}&to=${E(over)}`, t.staffH);
  assert.equal(r.status, 400);
  assert.ok(r.body.error.details.some((d: { code: string; max?: number }) => d.code === 'range_too_long' && d.max === 42));
});

test('OVERLAP: one person cannot have two overlapping shifts (409); touching shifts, other people and open shifts are fine', async () => {
  const t = await setup();
  const post = (b: Record<string, unknown>) => app.post(shiftsUrl(t.teamId), b, t.managerH);
  const first = await post(body({ assignedUserId: t.staff.id, startsAt: at(9), endsAt: at(17) }));
  assert.equal(first.status, 201);

  const clash = await post(body({ title: 'Clash', assignedUserId: t.staff.id, startsAt: at(16), endsAt: at(20) }));
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'shift_overlap');
  assert.equal(await db(t.teamId).shift.count({ where: { teamId: t.teamId } }), 1, 'nothing was written');
  assert.equal(await db(t.teamId).activity.count({ where: { teamId: t.teamId } }), 1, 'and no activity either');

  assert.equal((await post(body({ title: 'Touches', assignedUserId: t.staff.id, startsAt: at(17), endsAt: at(21) }))).status, 201, 'ends 17:00, next starts 17:00');
  assert.equal((await post(body({ title: 'Same time, someone else', assignedUserId: t.staff2.id }))).status, 201);
  assert.equal((await post(body({ title: 'Open 1' }))).status, 201);
  assert.equal((await post(body({ title: 'Open 2' }))).status, 201, 'open shifts may overlap each other');

  // An update that moves a shift into a clash is refused too; moving a shift within its OWN time is not a clash with itself.
  const later = await post(body({ title: 'Later', assignedUserId: t.staff.id, startsAt: at(9, 1), endsAt: at(12, 1) }));
  const id = later.body.shift.id as string;
  assert.equal((await app.patch(shiftsUrl(t.teamId, id), { startsAt: at(8), endsAt: at(10) }, t.managerH)).status, 409);
  assert.equal((await app.patch(shiftsUrl(t.teamId, id), { startsAt: at(10, 1), endsAt: at(13, 1) }, t.managerH)).status, 200);
  // Giving an existing shift to someone who is busy is refused.
  const open = (await post(body({ title: 'Open 3', startsAt: at(10), endsAt: at(12) }))).body.shift.id as string;
  assert.equal((await app.patch(shiftsUrl(t.teamId, open), { assignedUserId: t.staff.id }, t.managerH)).status, 409);
});

test('OVERLAP under concurrency: five simultaneous shifts for the same person and time give exactly one', async () => {
  const t = await setup();
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => app.post(shiftsUrl(t.teamId), body({ title: `Race ${i}`, assignedUserId: t.staff.id }), t.managerH)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal(await db(t.teamId).shift.count({ where: { teamId: t.teamId, assignedUserId: t.staff.id } }), 1);
});

test('the assignee must be a member of THIS team: a stranger, and a member of another team, are refused (400 not_a_member)', async () => {
  const t = await setup({ shard: 'A' });
  const other = await setup({ shard: 'B' });
  const stranger = await app.seedUser('Nobody');
  for (const userId of [stranger.id, other.staff.id, randomUUID()]) {
    const r = await app.post(shiftsUrl(t.teamId), body({ assignedUserId: userId }), t.managerH);
    assert.equal(r.status, 400);
    assert.ok(r.body.error.details.some((d: { path: string; code: string }) => d.path === 'assignedUserId' && d.code === 'not_a_member'));
  }
  assert.equal(await db(t.teamId).shift.count({ where: { teamId: t.teamId } }), 0);
});

test('update: a partial change keeps the rest, null clears optional fields and unassigns, and the activity names what changed', async () => {
  const t = await setup();
  const created = await app.post(shiftsUrl(t.teamId), body({ area: 'Bar', breakMinutes: 15, note: 'Old note', assignedUserId: t.staff.id }), t.managerH);
  const id = created.body.shift.id as string;

  const r1 = await app.patch(shiftsUrl(t.teamId, id), { title: 'Dinner service' }, t.ownerH);
  assert.equal(r1.status, 200);
  assert.deepEqual(
    { title: r1.body.shift.title, area: r1.body.shift.area, note: r1.body.shift.note, assignee: r1.body.shift.assignee?.id },
    { title: 'Dinner service', area: 'Bar', note: 'Old note', assignee: t.staff.id },
  );

  const r2 = await app.patch(shiftsUrl(t.teamId, id), { area: null, note: null, breakMinutes: null, assignedUserId: null }, t.managerH);
  assert.equal(r2.status, 200);
  assert.deepEqual([r2.body.shift.area, r2.body.shift.note, r2.body.shift.breakMinutes, r2.body.shift.assignee], [null, null, null, null]);

  const updates = await db(t.teamId).activity.findMany({ where: { shiftId: id, kind: 'shift_updated' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(updates.map((u) => (u.data as { changed: string[] }).changed), [['title'], ['area', 'breakMinutes', 'note', 'assignedUserId']]);
  assert.equal(updates[0]!.actorUserId, t.owner.id);
});

test('update: an empty body, a partial change that breaks the stored shift, and an unknown shift are refused', async () => {
  const t = await setup();
  const id = (await app.post(shiftsUrl(t.teamId), body({ startsAt: at(9), endsAt: at(17), breakMinutes: 30 }), t.managerH)).body.shift.id as string;
  const url = shiftsUrl(t.teamId, id);
  const empty = await app.patch(url, {}, t.managerH);
  assert.equal(empty.status, 400);
  assert.ok(empty.body.error.details.some((d: { code: string }) => d.code === 'nothing_to_change'));
  assert.equal((await app.patch(url, { extra: 1 }, t.managerH)).status, 400);
  const endsBeforeStored = await app.patch(url, { endsAt: at(8) }, t.managerH); // only the end is sent: checked against the stored start
  assert.equal(endsBeforeStored.status, 400);
  assert.ok(endsBeforeStored.body.error.details.some((d: { path: string; code: string }) => d.path === 'endsAt' && d.code === 'must_be_after_start'));
  const breakTooLong = await app.patch(url, { endsAt: at(9, 0, 20) }, t.managerH); // a 20-minute shift can't keep its 30-minute break
  assert.equal(breakTooLong.status, 400);
  assert.ok(breakTooLong.body.error.details.some((d: { code: string }) => d.code === 'break_too_long'));
  assert.equal((await app.patch(shiftsUrl(t.teamId, randomUUID()), { title: 'x' }, t.managerH)).status, 404);
  assert.equal((await db(t.teamId).shift.findUniqueOrThrow({ where: { id } })).endsAt.toISOString(), at(17), 'nothing changed');
});

test('unauthenticated requests are refused (401) before anything about the team is revealed', async () => {
  const t = await setup();
  const q = `?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(0, 1))}`;
  assert.equal((await app.get(shiftsUrl(t.teamId) + q)).status, 401);
  assert.equal((await app.post(shiftsUrl(t.teamId), body())).status, 401);
  assert.equal((await app.del(shiftsUrl(t.teamId, randomUUID()))).status, 401);
});

test('get one shift: any member may read it; another team\'s shift, an unknown one and a stranger all get the same 404', async () => {
  const x = await setup({ shard: 'A' });
  const y = await setup({ shard: 'B' });
  const id = (await app.post(shiftsUrl(x.teamId), body({ assignedUserId: x.staff.id }), x.managerH)).body.shift.id as string;
  const yId = (await app.post(shiftsUrl(y.teamId), body(), y.ownerH)).body.shift.id as string;

  const ok = await app.get(shiftsUrl(x.teamId, id), x.staffH);
  assert.equal(ok.status, 200);
  assert.deepEqual({ id: ok.body.shift.id, title: ok.body.shift.title, assignee: ok.body.shift.assignee?.name }, { id, title: 'Morning service', assignee: 'Sam Staff' });

  const unknown = await app.get(shiftsUrl(x.teamId, randomUUID()), x.ownerH);
  const otherTeams = await app.get(shiftsUrl(x.teamId, yId), x.ownerH); // Y's shift ID under MY team's path
  const stranger = await app.get(shiftsUrl(y.teamId, yId), x.ownerH); // a team I am not in
  for (const r of [unknown, otherTeams, stranger]) assert.equal(r.status, 404);
  assert.deepEqual(strip(otherTeams), strip(unknown));
  assert.deepEqual(strip(stranger), strip(unknown));
  assert.equal((await app.get(shiftsUrl(x.teamId, 'nope'), x.ownerH)).status, 400);
});
