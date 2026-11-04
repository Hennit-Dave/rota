import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { READ_YOUR_WRITES_MS } from './readRouting.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';

// The three opted-in endpoints (the shift calendar, the activity feed, the roster) over real HTTP, with the app built on the REAL read replicas of the
// test shards (ADR 0037). Two things are proved, with the evidence the replica itself gives:
//   1. A read with no reason to use the primary is answered by the replica: the replica client was asked the queries, and the request log says `none`.
//   2. The user who just wrote reads the primary for 5 s: the replica was asked NOTHING, the request log says `marker`, and the new data is in the answer.
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp({ replicas: true });
  // The process must be older than the startup window, or every read goes to the primary (reason startup).
  await sleep(READ_YOUR_WRITES_MS + 300);
});
after(() => app.stop());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (hour: number) => new Date(Date.UTC(2031, 2, 4, hour)).toISOString();

/** The `dbRoute` the request log recorded for the most recent GET. */
function lastGetRoute(): unknown {
  const lines = app
    .logLines()
    .map((l) => JSON.parse(l) as { msg?: string; method?: string; dbRoute?: unknown })
    .filter((l) => l.msg === 'request' && l.method === 'GET');
  return lines.at(-1)?.dbRoute;
}

test('calendar, feed and roster: the replica answers a read with no recent write; the writer reads the primary for 5 s, then the replica again', async () => {
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, name: 'The Olive Room' });
  const staff = await app.seedUser('Sam Staff');
  await app.addMember(teamId, staff.id, 'staff');
  const ownerH = bearer((await app.signIn(owner.id)).accessToken);
  const staffH = bearer((await app.signIn(staff.id)).accessToken);

  const calendar = `/teams/${teamId}/shifts?from=${at(0)}&to=${new Date(Date.UTC(2031, 2, 6)).toISOString()}`;
  const feed = `/teams/${teamId}/activity`;
  const roster = `/teams/${teamId}/members`;
  const endpoints = { calendar, feed, roster };

  // 1. No write has been made by anyone: every read is answered by the replica.
  for (const [name, url] of Object.entries(endpoints)) {
    const before = app.replicaQueries().length;
    const res = await app.get(url, ownerH);
    assert.equal(res.status, 200, `${name} answers`);
    assert.equal(lastGetRoute(), 'none', `${name}: no reason to use the primary`);
    assert.ok(app.replicaQueries().length > before, `${name}: the replica was asked`);
  }

  // 2. The Owner writes (publishes a shift), then reads straight away: the primary, and the answer already holds the new shift.
  const created = await app.post(`/teams/${teamId}/shifts`, { title: 'Morning service', startsAt: at(9), endsAt: at(17), assignedUserId: staff.id }, ownerH);
  assert.equal(created.status, 201);
  const wroteAt = Date.now();
  const shiftId = created.body.shift.id as string;

  for (const [name, url] of Object.entries(endpoints)) {
    const before = app.replicaQueries().length;
    const res = await app.get(url, ownerH);
    assert.equal(res.status, 200);
    assert.equal(lastGetRoute(), 'marker', `${name}: the user's own recent write`);
    assert.equal(app.replicaQueries().length, before, `${name}: the replica was asked nothing`);
    if (name === 'calendar') assert.ok(res.body.shifts.some((s: { id: string }) => s.id === shiftId), 'the new shift is in the calendar at once');
    if (name === 'feed') assert.ok(res.body.items.some((i: { shiftId: string; kind: string }) => i.shiftId === shiftId && i.kind === 'shift_created'), 'and in the feed');
  }

  // Someone else is not held back by the Owner's write: Sam's read goes to the replica.
  const beforeStaff = app.replicaQueries().length;
  assert.equal((await app.get(calendar, staffH)).status, 200);
  assert.equal(lastGetRoute(), 'none', "another user's read is not affected by the Owner's marker");
  assert.ok(app.replicaQueries().length > beforeStaff);

  // 3. Six seconds after the write: the Owner's reads go to the replica again, and it has caught up.
  await sleep(wroteAt + 6_000 - Date.now());
  for (const [name, url] of Object.entries(endpoints)) {
    const before = app.replicaQueries().length;
    const res = await app.get(url, ownerH);
    assert.equal(res.status, 200);
    assert.equal(lastGetRoute(), 'none', `${name}: back on the replica after 5 s`);
    assert.ok(app.replicaQueries().length > before, `${name}: the replica was asked`);
    if (name === 'calendar') assert.ok(res.body.shifts.some((s: { id: string }) => s.id === shiftId), 'the replica has the new shift by now');
  }
});

test('reads that must not lag stay on the primary: the permission check never asks the replica', async () => {
  const owner = await app.seedUser('Pia Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, name: 'The Pine Room' });
  // A removed member's access ends at once: demote then read as them. The role check reads the primary, so the very next call sees it.
  const sam = await app.seedUser('Sam Staff');
  await app.addMember(teamId, sam.id, 'manager');
  const samH = bearer((await app.signIn(sam.id)).accessToken);
  const url = `/teams/${teamId}/members`;
  assert.equal((await app.get(url, samH)).status, 200);
  await app.setRole(teamId, sam.id, 'staff');
  // 'members.list' is allowed to Staff too, so use an Owner/Manager-only action to see the changed role straight away.
  const res = await app.get(`/_test/teams/${teamId}/owner-manager-action`, samH);
  assert.equal(res.status, 403, 'the demotion applies on the very next request: the role is read from the primary');
});
