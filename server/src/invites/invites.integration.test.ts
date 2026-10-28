import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { hashInviteSecret, parseInviteToken } from './tokens.js';

let app: TeamsTestApp;
before(async () => {
  // Large ceilings: every request in this file comes from one IP and these tests make many invitations, previews and accepts. The limits and the
  // app-wide cap have their own tests (invites-limits.integration.test.ts).
  const big = { max: 10_000, windowSeconds: 3600 };
  app = await startTeamsTestApp({
    invites: { globalDailyCap: 10_000 },
    rateLimits: { invitePreviewIp: big, inviteAcceptIp: big, inviteAcceptUser: big },
  });
});
after(() => app.stop());

const strip = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });
const invitee = () => `invitee-${randomUUID()}@example.com`;

async function setup(opts: { shard?: 'A' | 'B' } = {}) {
  const owner = await app.seedUser('Dave Hennit');
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const ownerH = bearer((await app.signIn(owner.id)).accessToken);
  return { owner, teamId, shard, ownerH };
}

async function invite(teamId: string, headers: Record<string, string>, body: { email: string; role: string }) {
  return app.post(`/teams/${teamId}/invitations`, body, headers);
}

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;

test('create: the invitation and its email work row commit together on the team shard; only the HASH of the secret is stored', async () => {
  const { teamId, shard, ownerH } = await setup({ shard: 'B' });
  const email = invitee();
  const res = await invite(teamId, ownerH, { email: ` ${email.toUpperCase()} `, role: 'staff' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const inv = res.body.invitation;
  assert.equal(inv.email, email, 'trimmed and lowercased');
  assert.equal(inv.role, 'staff');
  assert.equal(inv.emailStatus, 'queued');
  assert.equal(inv.canResend, true);
  assert.equal(inv.canRevoke, true);
  assert.ok(Math.abs(new Date(inv.expiresAt).getTime() - (Date.now() + 7 * 86_400_000)) < 5 * 60_000, 'expires 7 days from now');

  // The invitation is on the team's shard (B here), the email work row is beside it, and they point at each other.
  const other = shard === 'A' ? 'B' : 'A';
  assert.equal(await app.raw[other].primary.invitation.count({ where: { id: inv.id } }), 0);
  const row = await app.raw[shard].primary.invitation.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(row.teamId, teamId);
  assert.equal(row.tokenHash.length, 32);
  assert.ok(row.emailWorkRowId);
  const work = await app.raw[shard].primary.workRow.findUniqueOrThrow({ where: { id: row.emailWorkRowId! } });
  assert.equal(work.kind, 'email');
  assert.equal(work.status, 'pending');
  assert.equal(work.originRequestId, res.headers.get('x-request-id'), 'the request that made it is on the row');
  const payload = work.payload as { to: string[]; subject: string; html: string; invitationId: string; tokenHashHex: string };
  assert.deepEqual(payload.to, [email]);
  assert.equal(payload.subject, 'Dave Hennit invited you to join The Olive Room on Rota');
  assert.equal(payload.invitationId, inv.id);

  // The raw secret lives only in the link (in the frozen payload), never in the invitations row, and it hashes to token_hash.
  const token = await app.tokenFromEmailRow(work.id, teamId);
  const parsed = parseInviteToken(token)!;
  assert.equal(parsed.teamId, teamId);
  assert.deepEqual(parsed.tokenHash, Buffer.from(row.tokenHash));
  assert.equal(payload.tokenHashHex, parsed.tokenHash.toString('hex'));
  assert.ok(payload.html.includes(`https://rota.davebuilds.design/invite/${token}`));
  const asText = await app.raw[shard].primary.$queryRaw<Array<{ t: string }>>`SELECT i::text AS t FROM invitations i WHERE id = ${inv.id}::uuid`;
  assert.ok(!asText[0]!.t.includes(parsed.secret), 'the secret is not in the invitations row');
  assert.deepEqual(app.enqueued().filter((e) => e.rowId === work.id), [{ rowId: work.id, shard }]);
});

test('who may invite whom: Owner -> Manager or Staff; Manager -> Staff only; Staff -> nobody; nobody -> Owner', async () => {
  const { teamId, ownerH } = await setup();
  const manager = await app.seedUser('Daniel Mensah');
  const staff = await app.seedUser('Amara Okafor');
  await app.addMember(teamId, manager.id, 'manager');
  await app.addMember(teamId, staff.id, 'staff');
  const managerH = bearer((await app.signIn(manager.id)).accessToken);
  const staffH = bearer((await app.signIn(staff.id)).accessToken);

  assert.equal((await invite(teamId, ownerH, { email: invitee(), role: 'manager' })).status, 201);
  assert.equal((await invite(teamId, ownerH, { email: invitee(), role: 'staff' })).status, 201);
  assert.equal((await invite(teamId, managerH, { email: invitee(), role: 'staff' })).status, 201);
  const before = await db(teamId).invitation.count({ where: { teamId } });

  const mgrInvitesMgr = await invite(teamId, managerH, { email: invitee(), role: 'manager' });
  assert.equal(mgrInvitesMgr.status, 403);
  assert.equal(mgrInvitesMgr.body.error.code, 'forbidden');
  for (const role of ['staff', 'manager']) assert.equal((await invite(teamId, staffH, { email: invitee(), role })).status, 403, `staff -> ${role}`);
  for (const h of [ownerH, managerH, staffH]) {
    const res = await invite(teamId, h, { email: invitee(), role: 'owner' });
    assert.equal(res.status, 400, 'nobody is invited as Owner');
    assert.equal(res.body.error.code, 'validation_failed');
  }
  assert.equal(await db(teamId).invitation.count({ where: { teamId } }), before, 'nothing was written by any refused request');
});

test('create validates the whole request: unknown key, bad email, missing or odd role, a query string, a non-canonical team ID', async () => {
  const { teamId, ownerH } = await setup();
  const ok = { email: invitee(), role: 'staff' };
  const cases: Array<[string, Promise<{ status: number; body: any }>]> = [
    ['unknown key', app.post(`/teams/${teamId}/invitations`, { ...ok, teamId }, ownerH)],
    ['extra key role-like', app.post(`/teams/${teamId}/invitations`, { ...ok, isOwner: true }, ownerH)],
    ['no email', app.post(`/teams/${teamId}/invitations`, { role: 'staff' }, ownerH)],
    ['bad email', app.post(`/teams/${teamId}/invitations`, { ...ok, email: 'sofia@example' }, ownerH)],
    ['email too long', app.post(`/teams/${teamId}/invitations`, { ...ok, email: `${'a'.repeat(250)}@example.com` }, ownerH)],
    ['no role', app.post(`/teams/${teamId}/invitations`, { email: ok.email }, ownerH)],
    ['role not a string', app.post(`/teams/${teamId}/invitations`, { ...ok, role: 7 }, ownerH)],
    ['role in the wrong case', app.post(`/teams/${teamId}/invitations`, { ...ok, role: 'Staff' }, ownerH)],
    ['query string', app.post(`/teams/${teamId}/invitations?x=1`, ok, ownerH)],
    ['uppercase team ID', app.post(`/teams/${teamId.toUpperCase()}/invitations`, ok, ownerH)],
  ];
  for (const [label, pending] of cases) {
    const res = await pending;
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error.code, 'validation_failed', label);
  }
  assert.equal(await db(teamId).invitation.count({ where: { teamId } }), 0);
});

test('a stranger gets the same 404 as an unknown team (across shards), and no token is 401', async () => {
  const x = await setup({ shard: 'A' });
  const y = await setup({ shard: 'B' });
  const body = { email: invitee(), role: 'staff' };
  const stranger = await invite(y.teamId, x.ownerH, body);
  const nowhere = await invite(randomUUID(), x.ownerH, body);
  assert.equal(stranger.status, 404);
  assert.deepEqual(strip(stranger), strip(nowhere));
  assert.equal(await db(y.teamId).invitation.count({ where: { teamId: y.teamId } }), 0);
  // list, resend and revoke too
  const invId = (await invite(y.teamId, y.ownerH, body)).body.invitation.id;
  for (const res of [
    await app.get(`/teams/${y.teamId}/invitations`, x.ownerH),
    await app.post(`/teams/${y.teamId}/invitations/${invId}/resend`, {}, x.ownerH),
    await fetch(`${app.base}/teams/${y.teamId}/invitations/${invId}`, { method: 'DELETE', headers: x.ownerH }).then((r) => ({ status: r.status })),
  ]) {
    assert.equal(res.status, 404);
  }
  assert.equal((await app.post(`/teams/${x.teamId}/invitations`, body)).status, 401);
});

test('an address already on the team is refused (409 already_member), the inviter included; nothing is written', async () => {
  const { owner, teamId, ownerH } = await setup();
  const member = await app.seedUser('Amara Okafor');
  await app.addMember(teamId, member.id, 'staff');
  for (const email of [member.email, owner.email]) {
    const res = await invite(teamId, ownerH, { email, role: 'staff' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'already_member');
  }
  assert.equal(await db(teamId).invitation.count({ where: { teamId } }), 0);
});

test('a pending invitation blocks a second one for the same address in any letter case (409 invite_pending); after a revoke it is allowed again', async () => {
  const { teamId, ownerH } = await setup();
  const email = invitee();
  const first = await invite(teamId, ownerH, { email, role: 'staff' });
  assert.equal(first.status, 201);
  for (const variant of [email, email.toUpperCase(), ` ${email} `]) {
    const again = await invite(teamId, ownerH, { email: variant, role: 'manager' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'invite_pending');
  }
  assert.equal(await db(teamId).invitation.count({ where: { teamId } }), 1);
  assert.equal(await db(teamId).workRow.count({ where: { kind: 'email', payload: { path: ['invitationId'], equals: first.body.invitation.id } } }), 1);

  const revoked = await fetch(`${app.base}/teams/${teamId}/invitations/${first.body.invitation.id}`, { method: 'DELETE', headers: ownerH });
  assert.equal(revoked.status, 204);
  const second = await invite(teamId, ownerH, { email, role: 'staff' });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.invitation.id, first.body.invitation.id, 'a revoked invitation is not reused');
});

test('two simultaneous invitations for one address: exactly one wins, one invitation and one email row exist', async () => {
  const { teamId, ownerH } = await setup();
  const email = invitee();
  const results = await Promise.all([
    invite(teamId, ownerH, { email, role: 'staff' }),
    invite(teamId, ownerH, { email, role: 'staff' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409)!.body.error.code, 'invite_pending');
  assert.equal(await db(teamId).invitation.count({ where: { teamId } }), 1);
  const winner = results.find((r) => r.status === 201)!.body.invitation.id;
  assert.equal(await db(teamId).workRow.count({ where: { kind: 'email', payload: { path: ['invitationId'], equals: winner } } }), 1);
});

test('an EXPIRED invitation for the same address is reused like a resend: same row, new token and expiry, a new email row, the old link dead', async () => {
  const { teamId, shard, ownerH } = await setup();
  const email = invitee();
  const first = await invite(teamId, ownerH, { email, role: 'staff' });
  const oldToken = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: first.body.invitation.id } })).emailWorkRowId!, teamId);
  await app.raw[shard].primary.$executeRaw`UPDATE invitations SET expires_at = NOW() - interval '1 minute' WHERE id = ${first.body.invitation.id}::uuid`;

  const again = await invite(teamId, ownerH, { email, role: 'manager' });
  assert.equal(again.status, 201);
  assert.equal(again.body.invitation.id, first.body.invitation.id, 'the same row');
  assert.equal(again.body.invitation.role, 'manager', 'the new role applies');
  const row = await db(teamId).invitation.findUniqueOrThrow({ where: { id: first.body.invitation.id } });
  const newToken = await app.tokenFromEmailRow(row.emailWorkRowId!, teamId);
  assert.notEqual(newToken, oldToken);
  assert.equal(await db(teamId).workRow.count({ where: { kind: 'email', payload: { path: ['invitationId'], equals: row.id } } }), 2);
  assert.equal((await app.post('/invitations/preview', { token: oldToken })).status, 404, 'the old link is dead');
  assert.equal((await app.post('/invitations/preview', { token: newToken })).status, 200);
});

test('GET /teams/:teamId tells the app which roles it may offer, from the permission table', async () => {
  const { teamId, ownerH } = await setup();
  const manager = await app.seedUser();
  const staff = await app.seedUser();
  await app.addMember(teamId, manager.id, 'manager');
  await app.addMember(teamId, staff.id, 'staff');
  const get = async (h: Record<string, string>) => (await app.get(`/teams/${teamId}`, h)).body;
  const o = await get(ownerH);
  assert.deepEqual([o.invitableRoles, o.canManageInvitations, o.canEditShifts], [['manager', 'staff'], true, true]);
  const m = await get(bearer((await app.signIn(manager.id)).accessToken));
  assert.deepEqual([m.invitableRoles, m.canManageInvitations, m.canEditShifts], [['staff'], true, true]);
  const s = await get(bearer((await app.signIn(staff.id)).accessToken));
  assert.deepEqual([s.invitableRoles, s.canManageInvitations, s.canEditShifts], [[], false, false]);
});

test('list: Owner and Manager see pending invitations with the email state; Staff 403; expired, revoked and accepted are not listed', async () => {
  const { teamId, shard, ownerH } = await setup();
  const manager = await app.seedUser();
  const staff = await app.seedUser();
  await app.addMember(teamId, manager.id, 'manager');
  await app.addMember(teamId, staff.id, 'staff');
  const managerH = bearer((await app.signIn(manager.id)).accessToken);
  const staffH = bearer((await app.signIn(staff.id)).accessToken);

  const a = (await invite(teamId, ownerH, { email: invitee(), role: 'staff' })).body.invitation;
  const b = (await invite(teamId, ownerH, { email: invitee(), role: 'manager' })).body.invitation;
  const c = (await invite(teamId, ownerH, { email: invitee(), role: 'staff' })).body.invitation; // will be expired
  const d = (await invite(teamId, ownerH, { email: invitee(), role: 'staff' })).body.invitation; // will be revoked
  await app.raw[shard].primary.$executeRaw`UPDATE invitations SET expires_at = NOW() - interval '1 minute' WHERE id = ${c.id}::uuid`;
  await fetch(`${app.base}/teams/${teamId}/invitations/${d.id}`, { method: 'DELETE', headers: ownerH });

  const listed = await app.get(`/teams/${teamId}/invitations`, ownerH);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.invitations.map((i: { id: string }) => i.id), [a.id, b.id]);
  assert.deepEqual(Object.keys(listed.body.invitations[0]).sort(), ['canResend', 'canRevoke', 'email', 'emailStatus', 'expiresAt', 'id', 'kind', 'role']);
  assert.equal(listed.body.invitations.every((i: { emailStatus: string }) => i.emailStatus === 'queued'), true);

  // The email state is read from the invitation's latest work row: queued -> sent, or failed (two ways).
  const rowOf = async (id: string) => (await db(teamId).invitation.findUniqueOrThrow({ where: { id } })).emailWorkRowId!;
  await db(teamId).workRow.update({ where: { id: await rowOf(a.id) }, data: { status: 'done', sentAt: new Date() } });
  await db(teamId).workRow.update({ where: { id: await rowOf(b.id) }, data: { status: 'failed', failureReason: 'terminal: test' } });
  const states = Object.fromEntries((await app.get(`/teams/${teamId}/invitations`, ownerH)).body.invitations.map((i: any) => [i.id, i.emailStatus]));
  assert.deepEqual(states, { [a.id]: 'sent', [b.id]: 'failed' });
  await db(teamId).workRow.update({ where: { id: await rowOf(a.id) }, data: { sentAt: null } }); // done but never sent: skipped, so "not sent"
  assert.equal((await app.get(`/teams/${teamId}/invitations`, ownerH)).body.invitations.find((i: any) => i.id === a.id).emailStatus, 'failed');

  // A Manager sees them all but may act only on what they could have created.
  const asManager = (await app.get(`/teams/${teamId}/invitations`, managerH)).body.invitations;
  assert.deepEqual(asManager.map((i: any) => [i.role, i.canResend, i.canRevoke]), [['staff', true, true], ['manager', false, false]]);
  assert.equal((await app.get(`/teams/${teamId}/invitations`, staffH)).status, 403);
  assert.equal((await app.get(`/teams/${teamId}/invitations?x=1`, ownerH)).status, 400);
});

test('resend: the same invitation gets a new token, expiry and email row; the old link dies at once; you can resend only what you could have created', async () => {
  const { teamId, ownerH } = await setup();
  const manager = await app.seedUser('Daniel Mensah');
  await app.addMember(teamId, manager.id, 'manager');
  const managerH = bearer((await app.signIn(manager.id)).accessToken);

  const created = (await invite(teamId, ownerH, { email: invitee(), role: 'staff' })).body.invitation;
  const before = await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } });
  const oldToken = await app.tokenFromEmailRow(before.emailWorkRowId!, teamId);

  const res = await app.post(`/teams/${teamId}/invitations/${created.id}/resend`, {}, managerH); // a Manager may resend a Staff invitation
  assert.equal(res.status, 200);
  assert.equal(res.body.invitation.id, created.id);
  assert.equal(res.body.invitation.emailStatus, 'queued');
  const after = await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } });
  assert.notDeepEqual(Buffer.from(after.tokenHash), Buffer.from(before.tokenHash));
  assert.notEqual(after.emailWorkRowId, before.emailWorkRowId, 'a new token is a new logical email: a new row');
  assert.equal(after.invitedByUserId, manager.id, 'the person who resent it is the sender now');
  assert.ok(after.expiresAt.getTime() >= before.expiresAt.getTime());
  const newWork = await db(teamId).workRow.findUniqueOrThrow({ where: { id: after.emailWorkRowId! } });
  assert.equal((newWork.payload as { subject: string }).subject, 'Daniel Mensah invited you to join The Olive Room on Rota');
  assert.ok(app.enqueued().some((e) => e.rowId === newWork.id));

  const newToken = await app.tokenFromEmailRow(after.emailWorkRowId!, teamId);
  assert.equal((await app.post('/invitations/preview', { token: oldToken })).status, 404, 'the old link is dead');
  assert.equal((await app.post('/invitations/preview', { token: newToken })).status, 200);

  // A Manager cannot resend a Manager invitation; an unknown id is 404; Staff cannot resend at all.
  const mgrInvite = (await invite(teamId, ownerH, { email: invitee(), role: 'manager' })).body.invitation;
  const refused = await app.post(`/teams/${teamId}/invitations/${mgrInvite.id}/resend`, {}, managerH);
  assert.equal(refused.status, 403);
  assert.equal((await app.post(`/teams/${teamId}/invitations/${randomUUID()}/resend`, {}, ownerH)).status, 404);
  const staff = await app.seedUser();
  await app.addMember(teamId, staff.id, 'staff');
  assert.equal((await app.post(`/teams/${teamId}/invitations/${created.id}/resend`, {}, bearer((await app.signIn(staff.id)).accessToken))).status, 403);
});

test('revoke: 204, then the link and accepting both say "unavailable"; a second revoke is 404; a Manager cannot revoke a Manager invitation', async () => {
  const { teamId, ownerH } = await setup();
  const manager = await app.seedUser();
  await app.addMember(teamId, manager.id, 'manager');
  const managerH = bearer((await app.signIn(manager.id)).accessToken);
  const del = (id: string, h: Record<string, string>) => fetch(`${app.base}/teams/${teamId}/invitations/${id}`, { method: 'DELETE', headers: h }).then((r) => r.status);

  const staffInv = (await invite(teamId, ownerH, { email: invitee(), role: 'staff' })).body.invitation;
  const mgrInv = (await invite(teamId, ownerH, { email: invitee(), role: 'manager' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: staffInv.id } })).emailWorkRowId!, teamId);

  assert.equal(await del(mgrInv.id, managerH), 403);
  assert.equal(await db(teamId).invitation.count({ where: { id: mgrInv.id, revokedAt: null } }), 1, 'still pending');
  assert.equal(await del(staffInv.id, managerH), 204);
  assert.equal(await del(staffInv.id, ownerH), 404, 'already gone');
  assert.equal(await del(randomUUID(), ownerH), 404);
  assert.equal((await app.post('/invitations/preview', { token })).status, 404);
  assert.equal((await app.post('/invitations/accept', { token }, ownerH)).status, 404, 'and accepting says the same');
});

test('preview consumes nothing and changes no row, however many times it is opened; the answer says whether the signed-in account matches', async () => {
  const { teamId, shard, ownerH } = await setup();
  const accepter = await app.seedUser('Amara Okafor');
  const other = await app.seedUser('Someone Else');
  const created = (await invite(teamId, ownerH, { email: accepter.email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);

  const rowBefore = await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM invitations WHERE id = ${created.id}::uuid`;
  const anon = await app.post('/invitations/preview', { token });
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.body, {
    status: 'pending',
    kind: 'email',
    team: { name: 'The Olive Room' },
    role: 'staff',
    inviter: { name: 'Dave Hennit', role: 'owner' },
    email: accepter.email,
    account: 'none',
  });
  for (let i = 0; i < 3; i++) await app.post('/invitations/preview', { token });
  const rowAfter = await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM invitations WHERE id = ${created.id}::uuid`;
  assert.deepEqual(rowAfter, rowBefore, 'opening the link changed nothing');
  assert.equal(await db(teamId).membership.count({ where: { teamId, userId: accepter.id } }), 0);

  const mine = await app.post('/invitations/preview', { token }, bearer((await app.signIn(accepter.id)).accessToken));
  assert.equal(mine.body.account, 'matches');
  const notMine = await app.post('/invitations/preview', { token }, bearer((await app.signIn(other.id)).accessToken));
  assert.equal(notMine.body.account, 'different');
  const stale = await app.post('/invitations/preview', { token }, bearer('aaa.bbb.ccc'));
  assert.equal(stale.status, 200, 'a bad or expired session is simply nobody signed in');
  assert.equal(stale.body.account, 'none');
});

test('unavailable is ONE answer: unknown, malformed, wrong team ID, expired, revoked and used links give byte-identical 404 invite_unavailable', async () => {
  const { teamId, shard, ownerH } = await setup();
  const otherTeam = await setup();
  const accepter = await app.seedUser('Amara Okafor');
  const mk = async (email: string) => {
    const inv = (await invite(teamId, ownerH, { email, role: 'staff' })).body.invitation;
    return { id: inv.id as string, token: await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: inv.id } })).emailWorkRowId!, teamId) };
  };
  const live = await mk(invitee());
  const expired = await mk(invitee());
  const revoked = await mk(invitee());
  const used = await mk(accepter.email);
  await app.raw[shard].primary.$executeRaw`UPDATE invitations SET expires_at = NOW() - interval '1 minute' WHERE id = ${expired.id}::uuid`;
  await fetch(`${app.base}/teams/${teamId}/invitations/${revoked.id}`, { method: 'DELETE', headers: ownerH });
  const accepterH = bearer((await app.signIn(accepter.id)).accessToken);
  assert.equal((await app.post('/invitations/accept', { token: used.token }, accepterH)).status, 200);
  // Every probe below is made by a DIFFERENT signed-in account: the one that accepted `used` gets its own success back (ADR 0015, tested separately).
  const bystander = await app.seedUser('Someone Else');
  const probeH = bearer((await app.signIn(bystander.id)).accessToken);

  const secret = live.token.split('.')[1]!;
  const badTokens = {
    unknown: `${teamId}.${Buffer.alloc(32, 7).toString('base64url')}`,
    wrongTeamId: `${otherTeam.teamId}.${secret}`, // a real team, with a real secret that belongs to another
    unknownTeamId: `${randomUUID()}.${secret}`,
    malformed: 'not a token',
    empty: 'x',
    uppercaseTeam: `${teamId.toUpperCase()}.${secret}`,
    expired: expired.token,
    revoked: revoked.token,
    used: used.token,
  };
  const answers = new Map<string, unknown>();
  for (const [label, token] of Object.entries(badTokens)) {
    const preview = await app.post('/invitations/preview', { token });
    assert.equal(preview.status, 404, `preview ${label}`);
    assert.equal(preview.body.error.code, 'invite_unavailable', label);
    answers.set(`preview:${label}`, strip(preview));
    const accept = await app.post('/invitations/accept', { token }, probeH);
    assert.equal(accept.status, 404, `accept ${label}`);
    assert.equal(accept.body.error.code, 'invite_unavailable', label);
    answers.set(`accept:${label}`, strip(accept));
  }
  assert.equal(new Set([...answers.values()].map((a) => JSON.stringify(a))).size, 1, 'every unavailable link answers identically, whatever the reason');
  assert.equal((await app.post('/invitations/preview', { token: live.token })).status, 200, 'and a live one still works');
});

test('accept: joins the team in the role the INVITATION holds, verifies the address, writes the directory, and clears NOTHING (ADR 0015)', async () => {
  const { teamId, ownerH } = await setup({ shard: 'B' });
  const accepter = await app.seedUser('Amara Okafor');
  await app.raw.A.primary.credential.create({ data: { userId: accepter.id, passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$test$hash-that-must-survive' } });
  const session = await app.signIn(accepter.id);
  const h = bearer(session.accessToken);
  const created = (await invite(teamId, ownerH, { email: accepter.email, role: 'manager' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);
  assert.equal((await app.raw.A.primary.user.findUniqueOrThrow({ where: { id: accepter.id } })).emailVerifiedAt, null);

  // The body cannot carry a role or a team: strict.
  assert.equal((await app.post('/invitations/accept', { token, role: 'owner' }, h)).status, 400);
  assert.equal((await app.post('/invitations/accept', { token, teamId }, h)).status, 400);

  const res = await app.post('/invitations/accept', { token }, h);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { team: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos' }, role: 'manager' });

  const membership = await app.raw.B.primary.membership.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId: accepter.id } } });
  assert.equal(membership.role, 'manager');
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: accepter.id, teamId } }), 1, 'directory row (ADR 0013)');
  const inv = await app.raw.B.primary.invitation.findUniqueOrThrow({ where: { id: created.id } });
  assert.ok(inv.acceptedAt);
  assert.equal(inv.acceptedByUserId, accepter.id);
  assert.ok((await app.raw.A.primary.user.findUniqueOrThrow({ where: { id: accepter.id } })).emailVerifiedAt, 'the address is verified');

  // No password clearing and no session revocation.
  const cred = await app.raw.A.primary.credential.findUniqueOrThrow({ where: { userId: accepter.id } });
  assert.equal(cred.passwordHash, '$argon2id$v=19$m=19456,t=2,p=1$test$hash-that-must-survive');
  const families = await app.raw.A.primary.refreshTokenFamily.findMany({ where: { userId: accepter.id } });
  assert.ok(families.length >= 1 && families.every((f) => f.revokedAt === null), 'no session was revoked');
  const teams = await app.get('/teams', h);
  assert.equal(teams.status, 200, 'the same access token still works');
  assert.deepEqual(teams.body.teams.map((t: { id: string; role: string }) => [t.id, t.role]), [[teamId, 'manager']]);
});

test('accept needs a signed-in account whose address is the invited one; otherwise nothing is granted and nothing is consumed', async () => {
  const { teamId, ownerH } = await setup();
  const invited = await app.seedUser('Amara Okafor');
  const other = await app.seedUser('Someone Else');
  const created = (await invite(teamId, ownerH, { email: invited.email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);

  assert.equal((await app.post('/invitations/accept', { token })).status, 401, 'no session');
  const wrong = await app.post('/invitations/accept', { token }, bearer((await app.signIn(other.id)).accessToken));
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'invite_wrong_account');
  assert.equal(await db(teamId).membership.count({ where: { teamId, userId: other.id } }), 0);
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: other.id } }), 0, 'no directory row for the wrong account');
  assert.equal((await app.raw.A.primary.user.findUniqueOrThrow({ where: { id: other.id } })).emailVerifiedAt, null, 'and its address is not marked verified');
  assert.equal(await db(teamId).invitation.count({ where: { id: created.id, acceptedAt: null } }), 1, 'the invitation is untouched');

  const right = await app.post('/invitations/accept', { token }, bearer((await app.signIn(invited.id)).accessToken));
  assert.equal(right.status, 200);
  // Single use: the link is spent for everyone else, including the account that was refused above.
  assert.equal((await app.post('/invitations/accept', { token }, bearer((await app.signIn(other.id)).accessToken))).status, 404, 'a different account: "unavailable"');
  assert.equal((await app.post('/invitations/accept', { token })).status, 401, 'nobody signed in');
});

test('two simultaneous accepts by the same person are one success twice, with exactly one membership and one directory row', async () => {
  const { teamId, ownerH } = await setup();
  const invited = await app.seedUser('Amara Okafor');
  const created = (await invite(teamId, ownerH, { email: invited.email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);
  const h = bearer((await app.signIn(invited.id)).accessToken);
  const results = await Promise.all([app.post('/invitations/accept', { token }, h), app.post('/invitations/accept', { token }, h)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200], 'whichever request lands first, both get the success');
  assert.deepEqual(results[0]!.body, results[1]!.body);
  assert.equal(await db(teamId).membership.count({ where: { teamId, userId: invited.id } }), 1);
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: invited.id, teamId } }), 1);
});

test('accept is idempotent for the account that already accepted: a retry (lost response, or a request that lands after the first) gets the SAME 200 and writes nothing', async () => {
  const { teamId, shard, ownerH } = await setup({ shard: 'B' });
  const invited = await app.seedUser('Amara Okafor');
  const h = bearer((await app.signIn(invited.id)).accessToken);
  const created = (await invite(teamId, ownerH, { email: invited.email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);

  const first = await app.post('/invitations/accept', { token }, h);
  assert.equal(first.status, 200);
  const rowAfterFirst = await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM invitations WHERE id = ${created.id}::uuid`;
  const membershipsAfterFirst = await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM memberships WHERE team_id = ${teamId}::uuid AND user_id = ${invited.id}::uuid`;

  // Strictly AFTER the first has finished, which is the timing that used to answer "unavailable".
  for (let i = 0; i < 3; i++) {
    const again = await app.post('/invitations/accept', { token }, h);
    assert.equal(again.status, 200, `retry ${i + 1}`);
    assert.deepEqual(again.body, first.body, 'the same answer');
  }
  assert.deepEqual(await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM invitations WHERE id = ${created.id}::uuid`, rowAfterFirst, 'a replay changes no invitation row');
  assert.deepEqual(await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM memberships WHERE team_id = ${teamId}::uuid AND user_id = ${invited.id}::uuid`, membershipsAfterFirst);
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: invited.id, teamId } }), 1);

  // It reports the membership as it is now, and only while the membership exists.
  await app.setRole(teamId, invited.id, 'manager');
  assert.equal((await app.post('/invitations/accept', { token }, h)).body.role, 'manager');
  await app.raw[shard].primary.membership.delete({ where: { teamId_userId: { teamId, userId: invited.id } } });
  const gone = await app.post('/invitations/accept', { token }, h);
  assert.equal(gone.status, 404, 'no membership any more: an ordinary "unavailable"');
  assert.equal(gone.body.error.code, 'invite_unavailable');
});

test('the replay is for that account ONLY: a different account, nobody, and a token that is not this invitation\'s all keep the identical 404 / 401', async () => {
  const { teamId, ownerH } = await setup();
  const other = await setup();
  const invited = await app.seedUser('Amara Okafor');
  const someoneElse = await app.seedUser('Someone Else');
  const created = (await invite(teamId, ownerH, { email: invited.email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);
  const invitedH = bearer((await app.signIn(invited.id)).accessToken);
  assert.equal((await app.post('/invitations/accept', { token }, invitedH)).status, 200);

  const unknown = await app.post('/invitations/accept', { token: `${teamId}.${Buffer.alloc(32, 5).toString('base64url')}` }, invitedH);
  const asOther = await app.post('/invitations/accept', { token }, bearer((await app.signIn(someoneElse.id)).accessToken));
  const wrongTeam = await app.post('/invitations/accept', { token: `${other.teamId}.${token.split('.')[1]}` }, invitedH);
  for (const res of [unknown, asOther, wrongTeam]) {
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'invite_unavailable');
  }
  assert.deepEqual(strip(asOther), strip(unknown), 'a stranger to the spent link cannot tell it from an unknown one');
  assert.deepEqual(strip(wrongTeam), strip(unknown));
  assert.equal((await app.post('/invitations/accept', { token })).status, 401, 'nobody signed in');
  assert.equal((await app.post('/invitations/preview', { token })).status, 404, 'and the preview of a spent link is "unavailable" with nobody signed in');
  assert.equal(await db(teamId).membership.count({ where: { teamId, userId: someoneElse.id } }), 0);
});

test('preview mirrors accept: the account that already accepted gets 200 already_member (the accept answer, plus a status); everyone else keeps the identical 404 (ADR 0017)', async () => {
  const { teamId, shard, ownerH } = await setup({ shard: 'B' });
  const other = await setup();
  const invited = await app.seedUser('Amara Okafor');
  const someoneElse = await app.seedUser('Someone Else');
  const created = (await invite(teamId, ownerH, { email: invited.email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);
  const invitedH = bearer((await app.signIn(invited.id)).accessToken);

  assert.equal((await app.post('/invitations/preview', { token }, invitedH)).body.status, 'pending', 'before accepting it is the ordinary preview');
  const accepted = await app.post('/invitations/accept', { token }, invitedH);
  assert.equal(accepted.status, 200);

  const rowBefore = await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM invitations WHERE id = ${created.id}::uuid`;
  const membershipsBefore = await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM memberships WHERE team_id = ${teamId}::uuid`;
  const replay = await app.post('/invitations/preview', { token }, invitedH);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { status: 'already_member', ...accepted.body }, 'the accept answer, plus a status');
  assert.deepEqual(await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM invitations WHERE id = ${created.id}::uuid`, rowBefore, 'a replay writes nothing');
  assert.deepEqual(await app.raw[shard].primary.$queryRaw<unknown[]>`SELECT * FROM memberships WHERE team_id = ${teamId}::uuid`, membershipsBefore);

  // Reports the membership as it is now.
  await app.setRole(teamId, invited.id, 'manager');
  assert.equal((await app.post('/invitations/preview', { token }, invitedH)).body.role, 'manager');

  // Everyone else keeps the identical answer, byte for byte, whether signed in or not.
  const unknown = await app.post('/invitations/preview', { token: `${teamId}.${Buffer.alloc(32, 5).toString('base64url')}` }, invitedH);
  const asOther = await app.post('/invitations/preview', { token }, bearer((await app.signIn(someoneElse.id)).accessToken));
  const asNobody = await app.post('/invitations/preview', { token });
  const asStale = await app.post('/invitations/preview', { token }, bearer('aaa.bbb.ccc'));
  const wrongTeam = await app.post('/invitations/preview', { token: `${other.teamId}.${token.split('.')[1]}` }, invitedH);
  for (const res of [unknown, asOther, asNobody, asStale, wrongTeam]) {
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'invite_unavailable');
  }
  for (const res of [asOther, asNobody, asStale, wrongTeam]) assert.deepEqual(strip(res), strip(unknown));

  // No membership any more, or a revoked invitation: an ordinary "unavailable" even for the account that accepted.
  await app.raw[shard].primary.membership.delete({ where: { teamId_userId: { teamId, userId: invited.id } } });
  assert.equal((await app.post('/invitations/preview', { token }, invitedH)).status, 404, 'membership gone');
  await app.raw[shard].primary.membership.create({ data: { teamId, userId: invited.id, role: 'staff' } });
  assert.equal((await app.post('/invitations/preview', { token }, invitedH)).status, 200, 'membership back (control)');
  await app.raw[shard].primary.$executeRaw`UPDATE invitations SET revoked_at = NOW() WHERE id = ${created.id}::uuid`;
  assert.equal((await app.post('/invitations/preview', { token }, invitedH)).status, 404, 'revoked');
});

test('a join that fails halfway (directory written, membership not): the invitation is NOT consumed, the retry completes it, and the session survives', async () => {
  const { teamId, ownerH } = await setup();
  const invited = await app.seedUser('Amara Okafor');
  const session = await app.signIn(invited.id);
  const h = bearer(session.accessToken);
  const created = (await invite(teamId, ownerH, { email: invited.email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);

  app.failMembershipInserts(true);
  let failed;
  try {
    failed = await app.post('/invitations/accept', { token }, h);
  } finally {
    app.failMembershipInserts(false);
  }
  assert.equal(failed.status, 500);
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: invited.id, teamId } }), 1, 'step 2 happened: the directory row is there');
  assert.equal(await db(teamId).membership.count({ where: { teamId, userId: invited.id } }), 0, 'step 3 did not: no membership');
  assert.equal(await db(teamId).invitation.count({ where: { id: created.id, acceptedAt: null } }), 1, 'the invitation was not consumed');
  assert.deepEqual((await app.get('/teams', h)).body.teams, [], 'the orphan directory row is not listed (ADR 0013)');

  const retry = await app.post('/invitations/accept', { token }, h);
  assert.equal(retry.status, 200);
  assert.equal(await db(teamId).membership.count({ where: { teamId, userId: invited.id } }), 1, 'one membership, never two');
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: invited.id, teamId } }), 1);
  assert.equal((await app.get('/teams', h)).body.teams.length, 1, 'and the same session still works');
});

test('if Valkey rejects the enqueue after the commit, the request still succeeds and the row is eligible for the sweep at once', async () => {
  const { teamId, shard, ownerH } = await setup();
  app.failEnqueue(true);
  let res;
  try {
    res = await invite(teamId, ownerH, { email: invitee(), role: 'staff' });
  } finally {
    app.failEnqueue(false);
  }
  assert.equal(res.status, 201, 'the request is not failed by the queue');
  const inv = await app.raw[shard].primary.invitation.findUniqueOrThrow({ where: { id: res.body.invitation.id } });
  const work = await app.raw[shard].primary.workRow.findUniqueOrThrow({ where: { id: inv.emailWorkRowId! } });
  assert.equal(work.status, 'pending');
  assert.ok(work.availableAt.getTime() <= Date.now() + 1000, 'available_at = now: the sweep restores it without waiting the 2 minutes');
  assert.ok(work.availableAt.getTime() < work.runAt.getTime() + 60_000);
});

test('REDACTION: no log line from the API carries the invite secret, the link or the invited address', async () => {
  const { teamId, ownerH } = await setup();
  const email = invitee();
  const accepter = await app.seedUser('Amara Okafor');
  const created = (await invite(teamId, ownerH, { email, role: 'staff' })).body.invitation;
  const token = await app.tokenFromEmailRow((await db(teamId).invitation.findUniqueOrThrow({ where: { id: created.id } })).emailWorkRowId!, teamId);
  await app.post('/invitations/preview', { token });
  await app.post('/invitations/accept', { token }, bearer((await app.signIn(accepter.id)).accessToken)); // wrong account: logged as rejected
  await app.post('/invitations/preview', { token: `${teamId}.${Buffer.alloc(32, 9).toString('base64url')}` });
  const secret = token.split('.')[1]!;
  const logs = app.logLines().join('\n');
  assert.ok(logs.length > 0);
  for (const needle of [secret, token, email, accepter.email, 'rota.davebuilds.design/invite']) {
    assert.ok(!logs.includes(needle), `a log line contains ${needle.slice(0, 12)}...`);
  }
  assert.ok(hashInviteSecret(secret).length === 32);
});
