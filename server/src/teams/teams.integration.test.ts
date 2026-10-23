import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from './testkit.js';

let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp();
});
after(() => app.stop());

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('POST /teams: the creator becomes Owner, the team lands on the shard its ID hashes to, and nowhere else', async () => {
  const user = await app.seedUser('Dave Hennit');
  const { accessToken } = await app.signIn(user.id);

  const res = await app.post('/teams', { name: '  The Olive Room  ', timeZone: 'Africa/Lagos' }, bearer(accessToken));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.body.team.id, CANONICAL, 'server-generated, canonical lowercase');
  assert.equal(res.body.team.name, 'The Olive Room', 'trimmed');
  assert.equal(res.body.team.timeZone, 'Africa/Lagos');
  assert.equal(res.body.role, 'owner');
  assert.ok(!Number.isNaN(Date.parse(res.body.team.createdAt)));

  const teamId: string = res.body.team.id;
  const expected = shardFor(teamId);
  const other = expected === 'A' ? 'B' : 'A';
  assert.deepEqual(await app.shardsHoldingTeam(teamId), [expected], 'the teams row is on exactly one shard: the hashed one');
  assert.equal(await app.raw[other].primary.membership.count({ where: { teamId } }), 0, 'no membership on the other shard');
  const memberships = await app.raw[expected].primary.membership.findMany({ where: { teamId } });
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]!.userId, user.id);
  assert.equal(memberships[0]!.role, 'owner');
  // The directory (ADR 0013) is on shard A whichever shard the team is on.
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: user.id, teamId } }), 1);
});

test('the database itself allows only one Owner per team (partial unique index)', async () => {
  const a = await app.seedUser();
  const b = await app.seedUser();
  const { teamId, shard } = await app.seedTeam({ ownerId: a.id });
  await assert.rejects(
    app.raw[shard].primary.membership.create({ data: { teamId, userId: b.id, role: 'owner' } }),
    (err: { code?: string }) => err.code === 'P2002',
  );
  await app.raw[shard].primary.membership.create({ data: { teamId, userId: b.id, role: 'manager' } }); // other roles are fine
});

test('POST /teams without a valid token: 401, and nothing is written', async () => {
  const body = { name: 'Nope', timeZone: 'Africa/Lagos' };
  const none = await app.post('/teams', body);
  const bad = await app.post('/teams', body, bearer('aaa.bbb.ccc'));
  assert.equal(none.status, 401);
  assert.equal(bad.status, 401);
  assert.equal(await app.raw.A.primary.team.count({ where: { name: 'Nope' } }), 0);
  assert.equal(await app.raw.B.primary.team.count({ where: { name: 'Nope' } }), 0);
});

test('POST /teams validates the whole request: unknown key, bad name, bad time zone, a query string. Each is 400 and writes nothing', async () => {
  const user = await app.seedUser();
  const { accessToken } = await app.signIn(user.id);
  const h = bearer(accessToken);
  const ok = { name: 'Fine', timeZone: 'Africa/Lagos' };

  const cases: Array<[string, Promise<{ status: number; body: any }>]> = [
    ['unknown key', app.post('/teams', { ...ok, role: 'owner' }, h)],
    ['missing name', app.post('/teams', { timeZone: 'Africa/Lagos' }, h)],
    ['empty name', app.post('/teams', { ...ok, name: '   ' }, h)],
    ['name over 80', app.post('/teams', { ...ok, name: 'x'.repeat(81) }, h)],
    ['name not a string', app.post('/teams', { ...ok, name: 7 }, h)],
    ['unknown time zone', app.post('/teams', { ...ok, timeZone: 'Mars/Olympus' }, h)],
    ['wrong-case time zone', app.post('/teams', { ...ok, timeZone: 'africa/lagos' }, h)],
    ['missing time zone', app.post('/teams', { name: 'Fine' }, h)],
    ['query string', app.post('/teams?admin=1', ok, h)],
  ];
  for (const [label, pending] of cases) {
    const res = await pending;
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error.code, 'validation_failed', label);
  }
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: user.id } }), 0, 'no directory row either');
});

test('a name of exactly 80 characters is accepted', async () => {
  const user = await app.seedUser();
  const { accessToken } = await app.signIn(user.id);
  const res = await app.post('/teams', { name: 'x'.repeat(80), timeZone: 'Europe/London' }, bearer(accessToken));
  assert.equal(res.status, 201);
});

test('if the team insert fails after the directory row, the row is an inert orphan: no team, never listed, and logged', async () => {
  const user = await app.seedUser();
  const { accessToken } = await app.signIn(user.id);
  app.failTeamInserts(true);
  let res;
  try {
    res = await app.post('/teams', { name: 'Doomed', timeZone: 'Africa/Lagos' }, bearer(accessToken));
  } finally {
    app.failTeamInserts(false);
  }
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'internal_error');

  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: user.id } }), 1, 'the directory row (step 1) is there');
  assert.equal(await app.raw.A.primary.team.count({ where: { name: 'Doomed' } }), 0);
  assert.equal(await app.raw.B.primary.team.count({ where: { name: 'Doomed' } }), 0);

  const list = await app.get('/teams', bearer(accessToken));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.teams, [], 'reads verify against the team shard, so the orphan grants and shows nothing');
  assert.ok(app.logLines().some((l) => l.includes('team_create_orphan_directory_row')));
});

test('GET /teams lists the caller\'s teams across BOTH shards, each with their own role, oldest first', async () => {
  const me = await app.seedUser();
  const boss = await app.seedUser();
  const { accessToken } = await app.signIn(me.id);

  const mine = await app.seedTeam({ ownerId: me.id, shard: 'A', name: 'Mine on A' });
  const theirs = await app.seedTeam({ ownerId: boss.id, shard: 'B', name: 'Theirs on B' });
  await app.addMember(theirs.teamId, me.id, 'staff');
  const someone = await app.seedTeam({ ownerId: boss.id, shard: 'A', name: 'Not mine' });

  const res = await app.get('/teams', bearer(accessToken));
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.teams.map((t: { id: string; name: string; role: string }) => [t.id, t.name, t.role]),
    [
      [mine.teamId, 'Mine on A', 'owner'],
      [theirs.teamId, 'Theirs on B', 'staff'],
    ],
  );
  assert.ok(!res.text.includes(someone.teamId), 'another team is not in the answer');
  assert.deepEqual(Object.keys(res.body.teams[0]).sort(), ['id', 'name', 'role', 'timeZone']);
});

test('GET /teams: a directory row with no membership (orphan) and a membership with no directory row are both not listed', async () => {
  const me = await app.seedUser();
  const { accessToken } = await app.signIn(me.id);

  await app.raw.A.primary.userTeam.create({ data: { userId: me.id, teamId: randomUUID() } }); // orphan
  const hidden = await app.seedTeam({ ownerId: me.id, skipDirectory: true }); // breaks the ADR 0013 write order on purpose

  const res = await app.get('/teams', bearer(accessToken));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.teams, []);
  assert.ok(!res.text.includes(hidden.teamId));
});

test('a join that failed halfway: the directory row and a REAL team exist but the membership does not. GET /teams leaves it out and it grants no access', async () => {
  const joiner = await app.seedUser();
  const owner = await app.seedUser();
  const { accessToken } = await app.signIn(joiner.id);
  const h = bearer(accessToken);

  // One real team on each shard, so the verification is proven on both. The joiner is a real member of a third team,
  // so the list is not trivially empty and the halfway teams are the only thing that could wrongly appear.
  const real = await app.seedTeam({ ownerId: joiner.id, shard: 'A', name: 'Really joined' });
  const halfA = await app.seedTeam({ ownerId: owner.id, shard: 'A', name: 'Half joined A' });
  const halfB = await app.seedTeam({ ownerId: owner.id, shard: 'B', name: 'Half joined B' });
  for (const half of [halfA, halfB]) {
    // The first step of a join (ADR 0013: directory row first) succeeded; the membership step never happened.
    await app.raw.A.primary.userTeam.create({ data: { userId: joiner.id, teamId: half.teamId } });
    assert.equal(await app.raw[half.shard].primary.team.count({ where: { id: half.teamId } }), 1, 'the team really exists');
    assert.equal(await app.raw[half.shard].primary.membership.count({ where: { teamId: half.teamId, userId: joiner.id } }), 0);
  }

  const list = await app.get('/teams', h);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.teams.map((t: { id: string }) => t.id), [real.teamId], 'only the real membership is listed');
  assert.ok(!list.text.includes('Half joined'), 'neither half-joined team name leaks');

  // The directory is never consulted for access: the same user is a stranger to both halfway teams.
  for (const half of [halfA, halfB]) {
    assert.equal((await app.get(`/teams/${half.teamId}`, h)).status, 404);
    assert.equal((await app.get(`/teams/${half.teamId}/members`, h)).status, 404);
  }

  // The retry that completes the join (membership now written) makes it appear: nothing was lost by the halfway failure.
  await app.raw.B.primary.membership.create({ data: { teamId: halfB.teamId, userId: joiner.id, role: 'staff' } });
  const retried = await app.get('/teams', h);
  assert.deepEqual(
    retried.body.teams.map((t: { id: string; role: string }) => [t.id, t.role]).sort(),
    [[real.teamId, 'owner'], [halfB.teamId, 'staff']].sort(),
  );
});

test('GET /teams with nothing: an empty list, not an error; with a query string: 400; without a token: 401', async () => {
  const me = await app.seedUser();
  const { accessToken } = await app.signIn(me.id);
  const empty = await app.get('/teams', bearer(accessToken));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { teams: [] });
  assert.equal((await app.get('/teams?limit=9999', bearer(accessToken))).status, 400);
  assert.equal((await app.get('/teams')).status, 401);
});

test('GET /teams/:teamId: a member of any role gets the team and their own role', async () => {
  const owner = await app.seedUser();
  const staff = await app.seedUser();
  const { teamId } = await app.seedTeam({ ownerId: owner.id, name: 'The Olive Room' });
  await app.addMember(teamId, staff.id, 'staff');

  for (const [user, role] of [[owner, 'owner'], [staff, 'staff']] as const) {
    const { accessToken } = await app.signIn(user.id);
    const res = await app.get(`/teams/${teamId}`, bearer(accessToken));
    assert.equal(res.status, 200);
    assert.equal(res.body.team.id, teamId);
    assert.equal(res.body.team.name, 'The Olive Room');
    assert.equal(res.body.role, role);
  }
});

test('route-parameter validation: an uppercase or malformed team ID is 400 (never a 500 from the shard function)', async () => {
  const user = await app.seedUser();
  const { accessToken } = await app.signIn(user.id);
  const { teamId } = await app.seedTeam({ ownerId: user.id });
  for (const bad of [teamId.toUpperCase(), 'not-a-uuid', '123', `${teamId}x`]) {
    for (const suffix of ['', '/members']) {
      const res = await app.get(`/teams/${bad}${suffix}`, bearer(accessToken));
      assert.equal(res.status, 400, `${bad}${suffix}`);
      assert.equal(res.body.error.code, 'validation_failed');
    }
  }
  assert.equal((await app.get(`/teams/${teamId}?x=1`, bearer(accessToken))).status, 400, 'unknown query key');
});

test('GET /teams/:teamId/members: names from shard A in ONE batched query, roles in order, and no emails', async () => {
  const owner = await app.seedUser('Dave Hennit');
  const manager = await app.seedUser('Daniel Mensah');
  const staff1 = await app.seedUser('Amara Okafor');
  const staff2 = await app.seedUser('Sofia Chen');
  const staff3 = await app.seedUser('Tunde Bello');
  // Team on shard B, so every query on shard A during the request is identity work.
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id, shard: 'B' });
  assert.equal(shard, 'B');
  await app.addMember(teamId, manager.id, 'manager');
  for (const s of [staff1, staff2, staff3]) await app.addMember(teamId, s.id, 'staff');

  const { accessToken } = await app.signIn(staff3.id); // a Staff member may list the team
  app.clearQueryLog();
  const res = await app.get(`/teams/${teamId}/members`, bearer(accessToken));
  assert.equal(res.status, 200);

  assert.deepEqual(
    res.body.members.map((m: { name: string; role: string }) => [m.name, m.role]),
    [
      ['Dave Hennit', 'owner'],
      ['Daniel Mensah', 'manager'],
      ['Amara Okafor', 'staff'],
      ['Sofia Chen', 'staff'],
      ['Tunde Bello', 'staff'],
    ],
  );
  assert.deepEqual(Object.keys(res.body.members[0]).sort(), ['joinedAt', 'name', 'role', 'userId']);
  for (const u of [owner, manager, staff1]) assert.ok(!res.text.includes(u.email), 'no email in the member list');

  const queries = app.queryLog();
  assert.deepEqual(queries.filter((q) => q.startsWith('A:User.')), ['A:User.findMany'], 'one batched users query for five members');
  assert.deepEqual(
    queries.filter((q) => q.startsWith('A:')),
    ['A:$queryRaw', 'A:User.findMany'],
    'on shard A: the session check and the one names query, nothing else',
  );
  assert.deepEqual(queries.filter((q) => q.startsWith('B:')), ['B:Membership.findUnique', 'B:Membership.findMany']);
});

test('a membership whose user no longer exists is left out of the list and logged, not a 500', async () => {
  const owner = await app.seedUser('Dave Hennit');
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id });
  await app.raw[shard].primary.membership.create({ data: { teamId, userId: randomUUID(), role: 'staff' } });
  const { accessToken } = await app.signIn(owner.id);
  const res = await app.get(`/teams/${teamId}/members`, bearer(accessToken));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.members.map((m: { name: string }) => m.name), ['Dave Hennit']);
  assert.ok(app.logLines().some((l) => l.includes('membership_without_user')));
});

test('the production app mounts /teams, and the test-only route does not exist in it', async () => {
  const mounted = await fetch(`${app.productionBase}/teams`);
  assert.equal(mounted.status, 401, '/teams is mounted and wants a token');
  const owner = await app.seedUser();
  const { teamId } = await app.seedTeam({ ownerId: owner.id });
  const { accessToken } = await app.signIn(owner.id);
  const testOnly = await fetch(`${app.productionBase}/_test/teams/${teamId}/owner-manager-action`, { headers: bearer(accessToken) });
  assert.equal(testOnly.status, 404, 'the test-only route is registered only inside the test harness');
  const harnessCopy = await app.get(`/_test/teams/${teamId}/owner-manager-action`, bearer(accessToken));
  assert.equal(harnessCopy.status, 200, 'but it does exist in the harness, so the 403 proof is real');
});
