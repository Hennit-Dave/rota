import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { seedActiveSubscription } from '../billing/testkit.js';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';

// Invite links (ADR 0025, issue #37; brief requirement 1 "invite team members by email or link"): a shareable, single-use link that is not tied to an
// email address. The TEST shards, real Valkey, real HTTP.
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp();
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const linksUrl = (teamId: string) => `/teams/${teamId}/invitations/links`;
const strip = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });
const tokenOf = (link: string) => link.slice(link.indexOf('/invite/') + '/invite/'.length);
const SECRET = (token: string) => token.split('.')[1]!;

async function setup(opts: { shard?: 'A' | 'B'; a?: typeof app } = {}) {
  const a = opts.a ?? app;
  const owner = await a.seedUser('Olive Owner');
  const { teamId, shard } = await a.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await a.seedUser('Maya Manager');
  await a.addMember(teamId, manager.id, 'manager');
  const staff = await a.seedUser('Sam Staff');
  await a.addMember(teamId, staff.id, 'staff');
  const h = async (id: string) => bearer((await a.signIn(id)).accessToken);
  return { teamId, shard, owner, manager, staff, ownerH: await h(owner.id), managerH: await h(manager.id), staffH: await h(staff.id), h };
}
type T = Awaited<ReturnType<typeof setup>>;

/** A stranger with an account of their own (nothing to do with the team), and their headers. */
async function stranger(name = 'Ada Newcomer') {
  const u = await app.seedUser(name);
  return { ...u, h: bearer((await app.signIn(u.id)).accessToken) };
}

async function makeLink(t: T, headers = t.ownerH) {
  const res = await app.post(linksUrl(t.teamId), undefined, headers);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { res, invitation: res.body.invitation, link: res.body.link as string, token: tokenOf(res.body.link) };
}
const preview = (token: string, headers: Record<string, string> = {}) => app.post('/invitations/preview', { token }, headers);
const accept = (token: string, headers: Record<string, string>) => app.post('/invitations/accept', { token }, headers);

for (const shardId of ['A', 'B'] as const) {
  test(`an Owner makes a link on shard ${shardId}: Staff only, no address, no email, and only the hash is stored`, async () => {
    const t = await setup({ shard: shardId });
    const before = app.enqueued().length;
    const made = await makeLink(t);
    const inv = made.invitation;
    assert.equal(made.res.headers.get('cache-control'), 'no-store');
    assert.deepEqual([inv.kind, inv.role, inv.email, inv.emailStatus, inv.canResend, inv.canRevoke], ['link', 'staff', null, null, false, true]);
    assert.ok(made.link.startsWith(`${app.config.invites.linkBaseUrl}/invite/${t.teamId}.`), 'the same App Link as the email invitation');
    const hours = (Date.parse(inv.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hours > app.config.invites.linkExpiryHours - 0.1 && hours <= app.config.invites.linkExpiryHours, `lives ${app.config.invites.linkExpiryHours} hours, not the email's 7 days`);

    const row = (await db(t.teamId).$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM invitations WHERE id = ${inv.id}::uuid`)[0]!;
    assert.deepEqual([row.kind, row.role, row.email, row.invited_by_user_id, row.email_work_row_id], ['link', 'staff', null, t.owner.id, null]);
    assert.ok(!JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? v.toString('base64') : v)).includes(SECRET(made.token)), 'the secret is in no column');
    assert.equal(app.enqueued().length, before, 'nothing was enqueued: a link sends no email');
    const work = await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM work_rows WHERE payload->>'invitationId' = ${inv.id}`;
    assert.equal(Number(work[0]!.n), 0, 'and no work row was written');
  });
}

test('a Manager may make a link too; Staff, a stranger and a visitor may not, and nothing is written', async () => {
  const t = await setup();
  const other = await setup({ shard: shardFor(t.teamId) === 'A' ? 'B' : 'A' });
  const count = async () => Number((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM invitations WHERE team_id = ${t.teamId}::uuid`)[0]!.n);
  assert.equal((await app.post(linksUrl(t.teamId), undefined, t.managerH)).status, 201);
  const baseline = await count();
  const staff = await app.post(linksUrl(t.teamId), undefined, t.staffH);
  assert.equal(staff.status, 403);
  assert.equal(staff.body.error.code, 'forbidden');
  assert.equal((await app.post(linksUrl(t.teamId), undefined, other.ownerH)).status, 404, "another team's Owner: it is not their team");
  assert.equal((await app.post(linksUrl(t.teamId))).status, 401);
  assert.equal(await count(), baseline, 'Staff, a stranger and a visitor created nothing');
});

test('there is no role to choose: a body, with a role or anything else, is refused', async () => {
  const t = await setup();
  assert.equal((await app.post(linksUrl(t.teamId), { role: 'manager' }, t.ownerH)).status, 400);
  assert.equal((await app.post(linksUrl(t.teamId), { role: 'staff' }, t.ownerH)).status, 400);
  assert.equal((await app.post(linksUrl(t.teamId), { email: 'x@example.com' }, t.ownerH)).status, 400);
  assert.equal((await app.get(`/teams/${t.teamId}/invitations`, t.ownerH)).body.invitations.length, 0);
});

test('the database itself refuses a Manager link, a link with an address and an email invitation without one', async () => {
  const t = await setup();
  const insert = (kind: string, email: string | null, role: string) =>
    db(t.teamId).$executeRaw`
      INSERT INTO invitations (team_id, kind, email, role, token_hash, expires_at, invited_by_user_id)
      VALUES (${t.teamId}::uuid, ${kind}::invitation_kind, ${email}, ${role}::team_role, ${Buffer.from(`${Math.random()}`)}, NOW() + interval '1 day', ${t.owner.id}::uuid)`;
  await assert.rejects(insert('link', null, 'manager'), /invitations_link_staff_only/);
  await assert.rejects(insert('link', 'a@example.com', 'staff'), /invitations_kind_email_match/);
  await assert.rejects(insert('email', null, 'staff'), /invitations_kind_email_match/);
});

test('the pending list shows a link with no address and no email state, to Owner and Manager only, and a used link leaves it', async () => {
  const t = await setup();
  const made = await makeLink(t);
  const list = await app.get(`/teams/${t.teamId}/invitations`, t.managerH);
  assert.equal(list.status, 200);
  const row = list.body.invitations.find((i: { id: string }) => i.id === made.invitation.id);
  assert.deepEqual([row.kind, row.email, row.emailStatus, row.role, row.canResend, row.canRevoke], ['link', null, null, 'staff', false, true]);
  assert.equal((await app.get(`/teams/${t.teamId}/invitations`, t.staffH)).status, 403);

  const joiner = await stranger();
  assert.equal((await accept(made.token, joiner.h)).status, 200);
  assert.equal((await app.get(`/teams/${t.teamId}/invitations`, t.ownerH)).body.invitations.length, 0, 'a used link is no longer pending');
});

test('ANY signed-in account may use it: no address to match, and it verifies no address', async () => {
  const t = await setup();
  const made = await makeLink(t);
  const joiner = await stranger('Ada Newcomer');
  const res = await accept(made.token, joiner.h);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.team.id, res.body.team.name, res.body.role], [t.teamId, 'The Olive Room', 'staff']);
  const m = await db(t.teamId).membership.findUnique({ where: { teamId_userId: { teamId: t.teamId, userId: joiner.id } } });
  assert.equal(m?.role, 'staff');
  const user = await app.raw.A.primary.user.findUniqueOrThrow({ where: { id: joiner.id } });
  assert.equal(user.emailVerifiedAt, null, 'a link proves nothing about the address, so the account stays unverified (security.md)');
  const inv = (await db(t.teamId).$queryRaw<Array<{ accepted_by_user_id: string; accepted_at: Date | null }>>`SELECT accepted_by_user_id::text, accepted_at FROM invitations WHERE id = ${made.invitation.id}::uuid`)[0]!;
  assert.equal(inv.accepted_by_user_id, joiner.id);
  assert.ok(inv.accepted_at);
  const dir = await app.raw.A.primary.userTeam.count({ where: { userId: joiner.id, teamId: t.teamId } });
  assert.equal(dir, 1, 'the directory row was written (ADR 0013)');
});

test('opening the link consumes nothing: preview shows the team and role, with no address', async () => {
  const t = await setup();
  const made = await makeLink(t, t.managerH);
  const visitor = await preview(made.token);
  assert.equal(visitor.status, 200);
  assert.deepEqual(
    [visitor.body.status, visitor.body.kind, visitor.body.email, visitor.body.account, visitor.body.role, visitor.body.team.name, visitor.body.inviter.name],
    ['pending', 'link', null, 'none', 'staff', 'The Olive Room', 'Maya Manager'],
  );
  const signedIn = await stranger();
  assert.equal((await preview(made.token, signedIn.h)).body.account, 'open', 'a signed-in account may accept: there is no address to compare');
  await preview(made.token);
  await preview(made.token, signedIn.h);
  const inv = (await db(t.teamId).$queryRaw<Array<{ accepted_at: Date | null }>>`SELECT accepted_at FROM invitations WHERE id = ${made.invitation.id}::uuid`)[0]!;
  assert.equal(inv.accepted_at, null, 'three previews, still unused');
});

test('SINGLE USE under a race: five people accept at once, exactly one gets in, the rest get the identical "unavailable" and no directory row', async () => {
  const t = await setup();
  const made = await makeLink(t);
  const people = await Promise.all([1, 2, 3, 4, 5].map((n) => stranger(`Racer ${n}`)));
  const results = await Promise.all(people.map((p) => accept(made.token, p.h)));
  const winners = results.filter((r) => r.status === 200);
  const losers = results.filter((r) => r.status !== 200);
  assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(losers.length, 4);
  for (const l of losers) {
    assert.equal(l.status, 404);
    assert.equal(l.body.error.code, 'invite_unavailable');
  }
  const members = await db(t.teamId).membership.findMany({ where: { teamId: t.teamId, userId: { in: people.map((p) => p.id) } } });
  assert.equal(members.length, 1, 'one membership');
  const loserIds = people.filter((p) => p.id !== members[0]!.userId).map((p) => p.id);
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: { in: loserIds }, teamId: t.teamId } }), 0, 'the losers were not left pointing at the team');
});

test('the second person to open a used link, and an expired, revoked, unknown, malformed or wrong-team one, all get the identical answer', async () => {
  const t = await setup();
  const other = await setup({ shard: shardFor(t.teamId) === 'A' ? 'B' : 'A' });
  const used = await makeLink(t);
  const first = await stranger();
  assert.equal((await accept(used.token, first.h)).status, 200);

  const expired = await makeLink(t);
  await db(t.teamId).$executeRaw`UPDATE invitations SET expires_at = NOW() - interval '1 second' WHERE id = ${expired.invitation.id}::uuid`;
  const revoked = await makeLink(t);
  assert.equal((await app.del(`/teams/${t.teamId}/invitations/${revoked.invitation.id}`, t.managerH)).status, 204, 'a Manager may revoke a link');
  const otherLink = await makeLink(other, other.ownerH);
  const wrongTeam = `${t.teamId}.${SECRET(otherLink.token)}`; // another team's secret under this team's ID

  const second = await stranger('Second Comer');
  const answers = [];
  for (const token of [used.token, expired.token, revoked.token, `${t.teamId}.${'A'.repeat(43)}`, wrongTeam, 'not-a-token']) {
    const a = await accept(token, second.h);
    assert.equal(a.status, 404, token);
    answers.push(strip(a));
    const p = await preview(token, second.h);
    assert.equal(p.status, 404);
    assert.deepEqual(strip(p), strip(a), 'preview and accept say the same');
  }
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.equal((answers[0] as Record<string, unknown>).code, 'invite_unavailable');
  assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: second.id } }), 0, 'the second person was given nothing');
});

test('the SAME account that used the link gets the same success again (a lost answer is safe to retry); it writes nothing', async () => {
  const t = await setup();
  const made = await makeLink(t);
  const joiner = await stranger();
  const first = await accept(made.token, joiner.h);
  const again = await accept(made.token, joiner.h);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal((await preview(made.token, joiner.h)).body.status, 'already_member');
  assert.equal(await db(t.teamId).membership.count({ where: { teamId: t.teamId, userId: joiner.id } }), 1);
});

test('someone already on the team who opens a link is sent to their team: the link is NOT consumed and their role never changes', async () => {
  const t = await setup();
  const made = await makeLink(t);
  const p = await preview(made.token, t.managerH);
  assert.equal(p.body.status, 'already_member');
  assert.equal(p.body.role, 'manager', 'the role they hold, not the link\'s');
  const a = await accept(made.token, t.managerH);
  assert.equal(a.status, 200);
  assert.equal(a.body.role, 'manager');
  assert.equal((await db(t.teamId).membership.findUniqueOrThrow({ where: { teamId_userId: { teamId: t.teamId, userId: t.manager.id } } })).role, 'manager');
  const inv = (await db(t.teamId).$queryRaw<Array<{ accepted_at: Date | null }>>`SELECT accepted_at FROM invitations WHERE id = ${made.invitation.id}::uuid`)[0]!;
  assert.equal(inv.accepted_at, null, 'the link is still unused');
  assert.equal((await accept(made.token, (await stranger()).h)).status, 200, 'so a newcomer can still use it');
});

test('a link needs a signed-in account to accept (preview is public, accept is not)', async () => {
  const t = await setup();
  const made = await makeLink(t);
  assert.equal((await app.post('/invitations/accept', { token: made.token })).status, 401);
  assert.equal((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM invitations WHERE id = ${made.invitation.id}::uuid AND accepted_at IS NULL`)[0]!.n, 1n);
});

test('revoking a link: it stops working at once, Staff may not revoke, and a link cannot be "sent again"', async () => {
  const t = await setup();
  const made = await makeLink(t);
  assert.equal((await app.del(`/teams/${t.teamId}/invitations/${made.invitation.id}`, t.staffH)).status, 403);
  assert.equal((await app.post(`/teams/${t.teamId}/invitations/${made.invitation.id}/resend`, undefined, t.ownerH)).status, 404, 'there is no address to send to');
  assert.equal((await preview(made.token)).status, 200, 'still live after a refused revoke and resend');
  assert.equal((await app.del(`/teams/${t.teamId}/invitations/${made.invitation.id}`, t.ownerH)).status, 204);
  assert.equal((await preview(made.token)).status, 404);
  assert.equal((await accept(made.token, (await stranger()).h)).status, 404);
});

test('what a person may do is the server\'s answer: GET /teams/:id says who may create a link', async () => {
  const t = await setup();
  for (const [h, expected] of [[t.ownerH, true], [t.managerH, true], [t.staffH, false]] as const) {
    const res = await app.get(`/teams/${t.teamId}`, h);
    assert.equal(res.body.canCreateInviteLink, expected);
  }
});

test('the email invitation is untouched: still bound to its address, still verifies it, and shows its address in the list', async () => {
  const t = await setup();
  const invitee = await app.seedUser('Eve Invited');
  const sent = await app.post(`/teams/${t.teamId}/invitations`, { email: invitee.email, role: 'staff' }, t.ownerH);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.invitation.kind, 'email');
  assert.equal(sent.body.invitation.email, invitee.email);
  assert.equal(sent.body.invitation.emailStatus, 'queued');
  const list = (await app.get(`/teams/${t.teamId}/invitations`, t.ownerH)).body.invitations;
  assert.equal(list.find((i: { id: string }) => i.id === sent.body.invitation.id).canResend, true);
  const wrong = await stranger('Not Eve');
  const token = await app.tokenFromEmailRow((await db(t.teamId).invitation.findUniqueOrThrow({ where: { id: sent.body.invitation.id } })).emailWorkRowId!, t.teamId);
  const refused = await accept(token, wrong.h);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'invite_wrong_account');
  const right = await accept(token, bearer((await app.signIn(invitee.id)).accessToken));
  assert.equal(right.status, 200);
  assert.ok((await app.raw.A.primary.user.findUniqueOrThrow({ where: { id: invitee.id } })).emailVerifiedAt, 'the email invitation still verifies the address');
  const preEmail = await preview(token, wrong.h);
  assert.equal(preEmail.status, 404, 'used');
});

// ---- limits ----

test('the pending cap: at most the configured number of links wait per team; revoking one frees a place; other teams are unaffected', async () => {
  const capped = await startTeamsTestApp({ invites: { linkMaxPending: 2 } });
  try {
    const t = await setup({ a: capped });
    const other = await setup({ a: capped });
    const make = (h: Record<string, string>, id = t.teamId) => capped.post(linksUrl(id), undefined, h);
    const first = await make(t.ownerH);
    assert.equal((await make(t.managerH)).status, 201);
    const third = await make(t.ownerH);
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'invite_link_limit');
    assert.equal((await make(other.ownerH, other.teamId)).status, 201, "another team's budget is its own");
    assert.equal((await capped.del(`/teams/${t.teamId}/invitations/${first.body.invitation.id}`, t.ownerH)).status, 204);
    assert.equal((await make(t.ownerH)).status, 201, 'a revoked link frees its place');
  } finally {
    await capped.stop();
  }
});

test('the cap holds under concurrency: five simultaneous requests for two places make exactly two links', async () => {
  const capped = await startTeamsTestApp({ invites: { linkMaxPending: 2 } });
  try {
    const t = await setup({ a: capped });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => capped.post(linksUrl(t.teamId), undefined, t.ownerH)));
    assert.equal(results.filter((r) => r.status === 201).length, 2, JSON.stringify(results.map((r) => r.status)));
    assert.equal(results.filter((r) => r.status === 409).length, 3);
    const n = await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM invitations WHERE team_id = ${t.teamId}::uuid AND kind = 'link'`;
    assert.equal(Number(n[0]!.n), 2);
  } finally {
    await capped.stop();
  }
});

test('link rate limits are per user and per team, and a link never uses the email cap', async () => {
  const limited = await startTeamsTestApp({
    rateLimits: { inviteLinkUser: { max: 2, windowSeconds: 60 }, inviteLinkTeam: { max: 3, windowSeconds: 60 } },
    invites: { globalDailyCap: 1, linkMaxPending: 50 },
  });
  try {
    const t = await setup({ a: limited });
    await seedActiveSubscription(limited.raw[shardFor(t.teamId)].primary, t.teamId, { plan: 'business', seats: 40 });
    assert.equal((await limited.post(linksUrl(t.teamId), undefined, t.ownerH)).status, 201);
    assert.equal((await limited.post(linksUrl(t.teamId), undefined, t.ownerH)).status, 201);
    const blockedUser = await limited.post(linksUrl(t.teamId), undefined, t.ownerH);
    assert.equal(blockedUser.status, 429);
    assert.equal(blockedUser.body.error.code, 'rate_limited');
    assert.equal((await limited.post(linksUrl(t.teamId), undefined, t.managerH)).status, 201, "another person's own limit");
    const blockedTeam = await limited.post(linksUrl(t.teamId), undefined, (await t.h(t.manager.id)));
    assert.equal(blockedTeam.status, 429, "the team's daily budget is spent");
    // Four links were made against an app-wide EMAIL cap of 1: links do not count toward it, so the one email invitation is still allowed.
    const invitee = await limited.seedUser('Eve');
    assert.equal((await limited.post(`/teams/${t.teamId}/invitations`, { email: invitee.email, role: 'staff' }, t.ownerH)).status, 201);
  } finally {
    await limited.stop();
  }
});

test('with Valkey down, creating a link fails closed with 503 and writes nothing', async () => {
  const dead = await startTeamsTestApp({ deadValkey: true });
  try {
    const t = await setup({ a: dead });
    const res = await dead.post(linksUrl(t.teamId), undefined, t.ownerH);
    assert.equal(res.status, 503);
    const n = await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM invitations WHERE team_id = ${t.teamId}::uuid`;
    assert.equal(Number(n[0]!.n), 0);
  } finally {
    await dead.stop();
  }
});

test('the production app serves the route too', async () => {
  const t = await setup();
  const res = await fetch(`${app.productionBase}${linksUrl(t.teamId)}`, { method: 'POST', headers: { ...t.ownerH, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 201);
});
