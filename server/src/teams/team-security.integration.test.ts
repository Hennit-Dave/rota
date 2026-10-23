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

// The two bodies may differ only by the request ID.
const stripId = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });

test('TEAM ISOLATION (brief, Requirement 4): a user from team X asking for team Y gets 404, with X and Y on DIFFERENT shards', async () => {
  const ownerX = await app.seedUser('Owner X');
  const ownerY = await app.seedUser('Owner Y');
  const x = await app.seedTeam({ ownerId: ownerX.id, shard: 'A', name: 'Team X secret name' });
  const y = await app.seedTeam({ ownerId: ownerY.id, shard: 'B', name: 'Team Y secret name' });

  // The evidence the two teams really are on different shards, from SQL and from the shard function.
  assert.notEqual(shardFor(x.teamId), shardFor(y.teamId));
  assert.deepEqual(await app.shardsHoldingTeam(x.teamId), ['A']);
  assert.deepEqual(await app.shardsHoldingTeam(y.teamId), ['B']);

  const tokenX = (await app.signIn(ownerX.id)).accessToken;
  const tokenY = (await app.signIn(ownerY.id)).accessToken;

  // X reaches for Y's data, by every team route.
  const team = await app.get(`/teams/${y.teamId}`, bearer(tokenX));
  const members = await app.get(`/teams/${y.teamId}/members`, bearer(tokenX));
  const guarded = await app.get(`/_test/teams/${y.teamId}/owner-manager-action`, bearer(tokenX));
  for (const res of [team, members, guarded]) {
    assert.equal(res.status, 404, 'another team\'s data is 404, never 403');
    assert.equal(res.body.error.code, 'not_found');
    assert.ok(!res.text.includes('Team Y'), 'nothing about Y leaks');
  }

  // 404 means "not found" for a team that exists exactly as for one that does not: the answers are indistinguishable.
  const nobody = await app.get(`/teams/${randomUUID()}`, bearer(tokenX));
  assert.equal(nobody.status, 404);
  assert.deepEqual(stripId(team), stripId(nobody));
  assert.deepEqual(stripId(members), stripId(await app.get(`/teams/${randomUUID()}/members`, bearer(tokenX))));

  // And the reverse direction, so it is not one-way luck; each owner still sees their own team.
  assert.equal((await app.get(`/teams/${x.teamId}`, bearer(tokenY))).status, 404);
  assert.equal((await app.get(`/teams/${x.teamId}/members`, bearer(tokenY))).status, 404);
  assert.equal((await app.get(`/teams/${x.teamId}`, bearer(tokenX))).status, 200);
  assert.equal((await app.get(`/teams/${y.teamId}`, bearer(tokenY))).status, 200);

  // Team Y's own listing never contains X's members, and vice versa.
  const listY = await app.get(`/teams/${y.teamId}/members`, bearer(tokenY));
  assert.deepEqual(listY.body.members.map((m: { name: string }) => m.name), ['Owner Y']);
});

test('team isolation also holds for a Staff member (a role in team X gives nothing in team Y)', async () => {
  const ownerX = await app.seedUser();
  const ownerY = await app.seedUser();
  const staffX = await app.seedUser();
  const x = await app.seedTeam({ ownerId: ownerX.id, shard: 'B' });
  const y = await app.seedTeam({ ownerId: ownerY.id, shard: 'A' });
  await app.addMember(x.teamId, staffX.id, 'staff');
  const token = (await app.signIn(staffX.id)).accessToken;

  const res = await app.get(`/teams/${y.teamId}`, bearer(token));
  assert.equal(res.status, 404);
  const guarded = await app.get(`/_test/teams/${y.teamId}/owner-manager-action`, bearer(token));
  assert.equal(guarded.status, 404, 'a stranger to the team gets 404 even on an Owner/Manager action, not 403');
});

test('ROLE ENFORCEMENT: Staff is rejected (403) on an Owner/Manager-only team action; Manager and Owner are allowed', async () => {
  const owner = await app.seedUser();
  const manager = await app.seedUser();
  const staff = await app.seedUser();
  const { teamId } = await app.seedTeam({ ownerId: owner.id });
  await app.addMember(teamId, manager.id, 'manager');
  await app.addMember(teamId, staff.id, 'staff');
  const path = `/_test/teams/${teamId}/owner-manager-action`;

  const asStaff = await app.get(path, bearer((await app.signIn(staff.id)).accessToken));
  assert.equal(asStaff.status, 403);
  assert.equal(asStaff.body.error.code, 'forbidden');

  const asManager = await app.get(path, bearer((await app.signIn(manager.id)).accessToken));
  assert.equal(asManager.status, 200);
  assert.equal(asManager.body.role, 'manager');
  const asOwner = await app.get(path, bearer((await app.signIn(owner.id)).accessToken));
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.body.role, 'owner');

  // Staff are not locked out of what Staff may do: the 403 is about the action, not the person.
  const staffToken = (await app.signIn(staff.id)).accessToken;
  assert.equal((await app.get(`/teams/${teamId}`, bearer(staffToken))).status, 200);
  assert.equal((await app.get(`/teams/${teamId}/members`, bearer(staffToken))).status, 200);
  assert.ok(app.logLines().some((l) => l.includes('role_staff_cannot_shifts.edit')), 'the real reason is in the log only');
});

test('ROLE FROM THE SERVER, NOT THE TOKEN (security.md test 3): demote a Manager and the SAME access token gets 403 on the next request', async () => {
  const owner = await app.seedUser();
  const manager = await app.seedUser();
  const { teamId } = await app.seedTeam({ ownerId: owner.id });
  await app.addMember(teamId, manager.id, 'manager');
  const token = (await app.signIn(manager.id)).accessToken;
  const path = `/_test/teams/${teamId}/owner-manager-action`;

  assert.equal((await app.get(path, bearer(token))).status, 200);
  await app.setRole(teamId, manager.id, 'staff'); // the demotion, straight after, no waiting
  const after = await app.get(path, bearer(token));
  assert.equal(after.status, 403, 'a demotion takes effect on the very next request');
  assert.equal(after.body.error.code, 'forbidden');
});

test('a removed member loses access on the next request, even though the directory still lists them (over-reporting is harmless)', async () => {
  const owner = await app.seedUser();
  const member = await app.seedUser();
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id });
  await app.addMember(teamId, member.id, 'staff');
  const token = (await app.signIn(member.id)).accessToken;
  assert.equal((await app.get(`/teams/${teamId}`, bearer(token))).status, 200);

  // ADR 0013: remove the membership FIRST; the directory row would be removed second. Stop in between, as a crash would.
  await app.raw[shard].primary.membership.delete({ where: { teamId_userId: { teamId, userId: member.id } } });
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: member.id, teamId } }), 1, 'directory still over-reports');

  assert.equal((await app.get(`/teams/${teamId}`, bearer(token))).status, 404);
  assert.equal((await app.get(`/teams/${teamId}/members`, bearer(token))).status, 404);
  assert.deepEqual((await app.get('/teams', bearer(token))).body.teams, [], 'and the list does not show it');
});

test('every membership read is a team-shard PRIMARY read made by the permission middleware (roles are primary-required)', async () => {
  const owner = await app.seedUser();
  const { teamId } = await app.seedTeam({ ownerId: owner.id, shard: 'A' });
  const token = (await app.signIn(owner.id)).accessToken;
  app.clearQueryLog();
  const res = await app.get(`/teams/${teamId}`, bearer(token));
  assert.equal(res.status, 200);
  assert.deepEqual(app.queryLog(), ['A:$queryRaw', 'A:Membership.findUnique'], 'session check, then ONE membership+team read');
  const line = app.logLines().map((l) => JSON.parse(l)).find((l) => l.route?.includes(':teamId') && l.status === 200);
  assert.equal(line?.dbRoute, 'primary-required');
});
