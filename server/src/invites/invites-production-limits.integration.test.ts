import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';

/**
 * The invitation limits at their REAL production values: this harness overrides nothing (no `rateLimits`, no `invites`), so every number below is
 * the default a deployed server uses. The other limit tests shrink the limits to keep fast; this file proves the real ones bite where the docs say.
 */
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp();
});
after(() => app.stop());

const invitee = () => `invitee-${randomUUID()}@example.com`;
const nobody = () => `${randomUUID()}.${Buffer.alloc(32, 3).toString('base64url')}`;

test('the production values are the approved ones, unmodified by this harness', () => {
  assert.deepEqual(app.config.rateLimits.inviteSendUser, { max: 10, windowSeconds: 3600 });
  assert.deepEqual(app.config.rateLimits.inviteSendTeam, { max: 20, windowSeconds: 86_400 });
  assert.deepEqual(app.config.rateLimits.invitePreviewIp, { max: 30, windowSeconds: 900 });
  assert.deepEqual(app.config.rateLimits.inviteAcceptUser, { max: 10, windowSeconds: 3600 });
  assert.deepEqual(app.config.rateLimits.inviteAcceptIp, { max: 30, windowSeconds: 900 });
  assert.equal(app.config.invites.globalDailyCap, 50);
  assert.equal(app.config.invites.expiryDays, 7);
});

test('INVITE CREATE at the production limit: the 10th invitation in the hour works, the 11th is 429 with Retry-After and writes nothing', async () => {
  const owner = await app.seedUser('Dave Hennit');
  const { teamId } = await app.seedTeam({ ownerId: owner.id });
  const h = bearer((await app.signIn(owner.id)).accessToken);
  for (let i = 1; i <= 10; i++) {
    const res = await app.post(`/teams/${teamId}/invitations`, { email: invitee(), role: 'staff' }, h);
    assert.equal(res.status, 201, `invitation ${i} of 10 is allowed`);
  }
  const eleventh = await app.post(`/teams/${teamId}/invitations`, { email: invitee(), role: 'staff' }, h);
  assert.equal(eleventh.status, 429, 'the 11th is over the production limit of 10 per hour');
  assert.equal(eleventh.body.error.code, 'rate_limited');
  const wait = Number(eleventh.headers.get('retry-after'));
  assert.ok(wait >= 1 && wait <= 3600, `Retry-After ${wait}s is inside the one-hour window`);
  assert.equal(await app.raw[shardFor(teamId)].primary.invitation.count({ where: { teamId } }), 10, 'the blocked request wrote nothing');
});

test('INVITE ACCEPT at the production limits: the 11th accept by one person in the hour is 429, and the 31st from one IP in 15 minutes is 429', async () => {
  const users = [await app.seedUser(), await app.seedUser(), await app.seedUser()];
  const headers = await Promise.all(users.map(async (u) => bearer((await app.signIn(u.id)).accessToken)));
  const accept = (h: Record<string, string>) => app.post('/invitations/accept', { token: nobody() }, h);

  // Per user: 10 are answered (404, the token is unknown), the 11th is refused by the per-user limit. (It still counts toward the IP: 11 so far.)
  for (let i = 1; i <= 10; i++) assert.equal((await accept(headers[0]!)).status, 404, `user 1, accept ${i} of 10`);
  const userBlocked = await accept(headers[0]!);
  assert.equal(userBlocked.status, 429, 'user 1: the 11th is over 10 per hour');
  assert.ok(Number(userBlocked.headers.get('retry-after')) >= 1);

  // Per IP: user 2 makes 10 more (21 so far), user 3 makes 9 (30 so far), and user 3's next request is the 31st from this IP.
  for (let i = 1; i <= 10; i++) assert.equal((await accept(headers[1]!)).status, 404, `user 2, accept ${i}`);
  for (let i = 1; i <= 9; i++) assert.equal((await accept(headers[2]!)).status, 404, `user 3, accept ${i}`);
  const ipBlocked = await accept(headers[2]!);
  assert.equal(ipBlocked.status, 429, 'the 31st accept from one IP in 15 minutes is over the production limit of 30');
  assert.equal(ipBlocked.body.error.code, 'rate_limited');
  assert.ok(Number(ipBlocked.headers.get('retry-after')) >= 1 && Number(ipBlocked.headers.get('retry-after')) <= 900);
});

test('INVITE PREVIEW at the production limit: 30 per IP in 15 minutes, the 31st is 429', async () => {
  // A token that does not parse is answered without a database query, so 31 requests are quick and still count.
  for (let i = 1; i <= 30; i++) assert.equal((await app.post('/invitations/preview', { token: 'not-a-token' })).status, 404, `preview ${i} of 30`);
  const blocked = await app.post('/invitations/preview', { token: 'not-a-token' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1 && Number(blocked.headers.get('retry-after')) <= 900);
});
