import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';

const invitee = () => `invitee-${randomUUID()}@example.com`;
const count = (app: TeamsTestApp, teamId: string) => app.raw[shardFor(teamId)].primary.invitation.count({ where: { teamId } });

async function owner(app: TeamsTestApp, name = 'Dave Hennit') {
  const user = await app.seedUser(name);
  const { teamId } = await app.seedTeam({ ownerId: user.id });
  return { user, teamId, h: bearer((await app.signIn(user.id)).accessToken) };
}
const send = (app: TeamsTestApp, teamId: string, h: Record<string, string>) => app.post(`/teams/${teamId}/invitations`, { email: invitee(), role: 'staff' }, h);

test('per-user limit: the third invitation in the window is 429 with Retry-After and writes nothing; resending counts too', async () => {
  const app = await startTeamsTestApp({ rateLimits: { inviteSendUser: { max: 3, windowSeconds: 3600 } }, invites: { globalDailyCap: 1000 } });
  try {
    const o = await owner(app);
    const first = await send(app, o.teamId, o.h);
    assert.equal(first.status, 201);
    assert.equal((await app.post(`/teams/${o.teamId}/invitations/${first.body.invitation.id}/resend`, {}, o.h)).status, 200);
    assert.equal((await send(app, o.teamId, o.h)).status, 201);
    const blocked = await send(app, o.teamId, o.h);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal(await count(app, o.teamId), 2, 'the blocked request wrote nothing');
    assert.equal((await app.get(`/teams/${o.teamId}/invitations`, o.h)).status, 200, 'reading is not limited');
    // Revoking is not sending an email, so it is not limited either.
    const del = await fetch(`${app.base}/teams/${o.teamId}/invitations/${first.body.invitation.id}`, { method: 'DELETE', headers: o.h });
    assert.equal(del.status, 204);
  } finally {
    await app.stop();
  }
});

test('per-team limit: a team that has used its budget is blocked for everyone on it, other teams are not', async () => {
  const app = await startTeamsTestApp({ rateLimits: { inviteSendTeam: { max: 2, windowSeconds: 86_400 } }, invites: { globalDailyCap: 1000 } });
  try {
    const a = await owner(app);
    const b = await owner(app);
    const manager = await app.seedUser('Daniel Mensah');
    await app.addMember(a.teamId, manager.id, 'manager');
    const managerH = bearer((await app.signIn(manager.id)).accessToken);
    assert.equal((await send(app, a.teamId, a.h)).status, 201);
    assert.equal((await send(app, a.teamId, managerH)).status, 201);
    const blocked = await send(app, a.teamId, a.h);
    assert.equal(blocked.status, 429);
    assert.equal(await count(app, a.teamId), 2);
    assert.equal((await send(app, b.teamId, b.h)).status, 201, 'another team has its own budget');
  } finally {
    await app.stop();
  }
});

test('a stranger or a Staff member hitting a team cannot use up its team budget or the app-wide cap (the limits run AFTER the membership check)', async () => {
  const app = await startTeamsTestApp({ rateLimits: { inviteSendTeam: { max: 2, windowSeconds: 86_400 } }, invites: { globalDailyCap: 2 } });
  try {
    const victim = await owner(app);
    const bystander = await owner(app);
    const staff = await app.seedUser('Amara Okafor');
    await app.addMember(victim.teamId, staff.id, 'staff');
    const staffH = bearer((await app.signIn(staff.id)).accessToken);

    for (let i = 0; i < 6; i++) {
      assert.equal((await send(app, victim.teamId, bystander.h)).status, 404, 'a stranger to the team');
      assert.equal((await send(app, victim.teamId, staffH)).status, 403, 'a member without the permission');
    }
    assert.equal(await count(app, victim.teamId), 0);
    // The victim's budget (2 for the team, 2 for the app) is untouched.
    assert.equal((await send(app, victim.teamId, victim.h)).status, 201);
    assert.equal((await send(app, victim.teamId, victim.h)).status, 201);
    assert.equal((await send(app, victim.teamId, victim.h)).status, 429, 'and only now is it spent');
  } finally {
    await app.stop();
  }
});

test('the app-wide daily cap: spent by anyone, it blocks every team with Retry-After until 00:00 UTC, and a caller blocked EARLIER does not use any of it up', async () => {
  const app = await startTeamsTestApp({ rateLimits: { inviteSendUser: { max: 1, windowSeconds: 3600 } }, invites: { globalDailyCap: 2 } });
  try {
    const a = await owner(app);
    const b = await owner(app);
    const c = await owner(app);
    assert.equal((await send(app, a.teamId, a.h)).status, 201); // global 1 of 2
    assert.equal((await send(app, a.teamId, a.h)).status, 429, 'blocked by the per-user limit, before the cap'); // must NOT count
    assert.equal((await send(app, b.teamId, b.h)).status, 201, 'so the second slot is still free'); // global 2 of 2
    const capped = await send(app, c.teamId, c.h);
    assert.equal(capped.status, 429);
    assert.equal(capped.body.error.code, 'rate_limited');
    const wait = Number(capped.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= 86_400, `Retry-After ${wait}s is within the UTC day`);
    assert.equal(await count(app, c.teamId), 0);
  } finally {
    await app.stop();
  }
});

test('preview and accept are limited by IP, and accept by user too', async () => {
  const app = await startTeamsTestApp({
    rateLimits: {
      invitePreviewIp: { max: 2, windowSeconds: 900 },
      inviteAcceptIp: { max: 3, windowSeconds: 900 },
      inviteAcceptUser: { max: 1, windowSeconds: 3600 },
    },
  });
  try {
    const nobody = `${randomUUID()}.${Buffer.alloc(32, 1).toString('base64url')}`;
    assert.equal((await app.post('/invitations/preview', { token: nobody })).status, 404);
    assert.equal((await app.post('/invitations/preview', { token: nobody })).status, 404);
    const blocked = await app.post('/invitations/preview', { token: nobody });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

    const user = await app.seedUser();
    const h = bearer((await app.signIn(user.id)).accessToken);
    assert.equal((await app.post('/invitations/accept', { token: nobody }, h)).status, 404);
    const userBlocked = await app.post('/invitations/accept', { token: nobody }, h);
    assert.equal(userBlocked.status, 429, 'the per-user accept limit (1) is spent');
    const other = await app.seedUser();
    assert.equal((await app.post('/invitations/accept', { token: nobody }, bearer((await app.signIn(other.id)).accessToken))).status, 404);
    const ipBlocked = await app.post('/invitations/accept', { token: nobody }, bearer((await app.signIn(user.id)).accessToken));
    assert.equal(ipBlocked.status, 429, 'and the IP limit (3) is spent too');
  } finally {
    await app.stop();
  }
});

test('with Valkey down every limited invitation route fails CLOSED (503) and writes nothing; reads do not need Valkey', async () => {
  const app = await startTeamsTestApp({ deadValkey: true });
  try {
    const o = await owner(app);
    const res = await send(app, o.teamId, o.h);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(await count(app, o.teamId), 0);
    assert.equal(await app.raw[shardFor(o.teamId)].primary.workRow.count({ where: { kind: 'email', originRequestId: res.headers.get('x-request-id') } }), 0);

    const nobody = `${o.teamId}.${Buffer.alloc(32, 2).toString('base64url')}`;
    assert.equal((await app.post('/invitations/preview', { token: nobody })).status, 503);
    assert.equal((await app.post('/invitations/accept', { token: nobody }, o.h)).status, 503);
    assert.equal((await app.get(`/teams/${o.teamId}/invitations`, o.h)).status, 200, 'listing reads only Postgres');
  } finally {
    await app.stop();
  }
});
