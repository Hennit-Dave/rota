import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { seedActiveSubscription } from './testkit.js';

// Seat limits, enforced on the server (the brief: "An owner on Starter cannot invite a sixth person"). A seat is an active member, the Owner included; a usable
// invitation holds a seat for its person. A team that has not activated works within Starter's five seats (ADR 0026). TEST shards, real HTTP.
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp({ invites: { globalDailyCap: 1000, linkMaxPending: 50 }, rateLimits: { inviteSendUser: { max: 1000, windowSeconds: 60 }, inviteSendTeam: { max: 1000, windowSeconds: 60 }, inviteLinkUser: { max: 1000, windowSeconds: 60 }, inviteLinkTeam: { max: 1000, windowSeconds: 60 }, inviteAcceptUser: { max: 1000, windowSeconds: 60 }, inviteAcceptIp: { max: 1000, windowSeconds: 60 } } });
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const invitee = () => `invitee-${randomUUID()}@example.com`;
const inviteUrl = (teamId: string) => `/teams/${teamId}/invitations`;

/** A team whose Owner and `others` more members already sit in it: `others + 1` seats are taken. */
async function teamWith(others: number, shard?: 'A' | 'B') {
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, shard, name: 'The Olive Room' });
  for (let i = 0; i < others; i++) await app.addMember(teamId, (await app.seedUser(`Member ${i}`)).id, 'staff');
  return { teamId, owner, ownerH: bearer((await app.signIn(owner.id)).accessToken) };
}
const memberCount = (teamId: string) => db(teamId).membership.count({ where: { teamId } });
const invitationCount = (teamId: string) => db(teamId).invitation.count({ where: { teamId } });

async function acceptAs(token: string) {
  const user = await app.seedUser('Newcomer');
  const h = bearer((await app.signIn(user.id)).accessToken);
  return { user, res: await app.post('/invitations/accept', { token }, h) };
}

for (const shard of ['A', 'B'] as const) {
  test(`THE SIXTH STARTER SEAT IS REFUSED on shard ${shard}: five seats are Owner + 4, the fifth is held by a waiting invitation, and the next invitation is 409 and writes nothing`, async () => {
    const { teamId, ownerH } = await teamWith(3, shard); // 4 seats taken
    const fifth = await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH);
    assert.equal(fifth.status, 201, 'the fifth seat is free');
    assert.equal(await invitationCount(teamId), 1);

    const sixth = await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH);
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.error.code, 'seat_limit_reached');
    assert.equal(await invitationCount(teamId), 1, 'the refused invitation wrote nothing (the transaction rolled back)');
    const workRows = await db(teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM work_rows WHERE kind = 'email' AND payload->>'invitationId' IN (SELECT id::text FROM invitations WHERE team_id = ${teamId}::uuid)`;
    assert.equal(Number(workRows[0]!.n), 1, 'and queued no email');

    const link = await app.post(`${inviteUrl(teamId)}/links`, undefined, ownerH);
    assert.equal(link.status, 409, 'a link needs a free seat too');
    assert.equal(link.body.error.code, 'seat_limit_reached');
    assert.equal(await invitationCount(teamId), 1);
    assert.equal(await memberCount(teamId), 4);
  });
}

test('a revoked invitation gives its seat back', async () => {
  const { teamId, ownerH } = await teamWith(3);
  const first = await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH);
  assert.equal((await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH)).status, 409);
  const revoked = await app.del(`${inviteUrl(teamId)}/${first.body.invitation.id}`, ownerH);
  assert.ok(revoked.status === 200 || revoked.status === 204, `revoke answered ${revoked.status}`);
  assert.equal((await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH)).status, 201, 'the seat is free again');
});

test('THE ACCEPT IS THE AUTHORITY: a seat taken another way after the invitation was made refuses the accept (409), consumes nothing, and works once a seat is free', async () => {
  const { teamId, ownerH } = await teamWith(3);
  // The invited person already has an account under the address the invitation names.
  const email = invitee();
  const account = await app.raw.A.primary.user.create({ data: { email, name: 'Invited Person' } });
  const h = bearer((await app.signIn(account.id)).accessToken);
  try {
    const made = await app.post(inviteUrl(teamId), { email, role: 'staff' }, ownerH);
    assert.equal(made.status, 201);
    const invitation = await db(teamId).invitation.findUniqueOrThrow({ where: { id: made.body.invitation.id } });
    const token = await app.tokenFromEmailRow(invitation.emailWorkRowId!, teamId);

    // Somebody else takes the fifth seat by another route (here: straight into the table).
    const sneaky = await app.seedUser('Sneaky Member');
    await app.addMember(teamId, sneaky.id, 'staff');
    assert.equal(await memberCount(teamId), 5);

    const refused = await app.post('/invitations/accept', { token }, h);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'seat_limit_reached');
    assert.equal(await memberCount(teamId), 5, 'no sixth member');
    const still = await db(teamId).invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    assert.equal(still.acceptedAt, null, 'the invitation was NOT consumed');
    assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: account.id, teamId } }), 0, 'and no directory row was left pointing at the team');

    // A seat frees up: the very same invitation now works.
    await db(teamId).membership.deleteMany({ where: { teamId, userId: sneaky.id } });
    const accepted = await app.post('/invitations/accept', { token }, h);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(await memberCount(teamId), 5);
  } finally {
    await app.raw.A.primary.user.deleteMany({ where: { id: account.id } });
  }
});

test('two people racing for the last seat: exactly one gets it, the other is 409 (the team row lock serialises the accepts)', async () => {
  const { teamId, ownerH } = await teamWith(2); // 3 seats taken, 2 free
  const links: string[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await app.post(`${inviteUrl(teamId)}/links`, undefined, ownerH);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    links.push(String(res.body.link).split('/invite/')[1]!);
  }
  // One of the two reserved seats is taken another way, so two invitations now compete for ONE free seat.
  await app.addMember(teamId, (await app.seedUser('Walk-in')).id, 'staff');
  assert.equal(await memberCount(teamId), 4);

  const results = await Promise.all(links.map((token) => acceptAs(token)));
  try {
    const statuses = results.map((r) => r.res.status).sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify(results.map((r) => r.res.body)));
    assert.equal(results.find((r) => r.res.status === 409)!.res.body.error.code, 'seat_limit_reached');
    assert.equal(await memberCount(teamId), 5, 'never over the limit');
  } finally {
    await app.raw.A.primary.user.deleteMany({ where: { id: { in: results.map((r) => r.user.id) } } });
  }
});

test('two simultaneous invitations for the last seat: one is created, the other is 409', async () => {
  const { teamId, ownerH } = await teamWith(3);
  const [a, b] = await Promise.all([
    app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH),
    app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(await invitationCount(teamId), 1);
});

test('an ACTIVATED team has the seats it bought, not Starter\'s five', async () => {
  const { teamId, ownerH } = await teamWith(4); // 5 members
  assert.equal((await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH)).status, 409, 'Starter is full');
  await seedActiveSubscription(db(teamId), teamId, { plan: 'team', seats: 7 });
  assert.equal((await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH)).status, 201, 'sixth seat');
  assert.equal((await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH)).status, 201, 'seventh seat');
  const eighth = await app.post(inviteUrl(teamId), { email: invitee(), role: 'staff' }, ownerH);
  assert.equal(eighth.status, 409, 'the subscription has 7 seats');
  assert.equal(eighth.body.error.code, 'seat_limit_reached');
});
