import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { createWorkProcessor } from '../jobs/worker.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { createReductionBoundaryHandler } from './reductions.js';
import { FakeStripe } from './stripe.testkit.js';
import { seedActiveSubscription } from './testkit.js';

// Reductions at the end of the period (ADR 0029): the real routes, the real boundary job through the real work processor, the TEST shards.
// "Now" is pinned to 2031-06-19, inside a 30-day period 2031-06-01 to 2031-07-01. Rows are fresh per test (a team, its members, its scheduled change).
let app: TeamsTestApp;
const clock = new Date('2031-06-19T10:00:00.000Z');
before(async () => {
  app = await startTeamsTestApp({
    billing: { stripe: new FakeStripe(), now: () => clock },
    invites: { globalDailyCap: 1000, linkMaxPending: 50 },
    rateLimits: { inviteSendUser: { max: 1000, windowSeconds: 60 }, inviteSendTeam: { max: 1000, windowSeconds: 60 }, inviteLinkUser: { max: 1000, windowSeconds: 60 }, inviteLinkTeam: { max: 1000, windowSeconds: 60 }, inviteAcceptUser: { max: 1000, windowSeconds: 60 }, inviteAcceptIp: { max: 1000, windowSeconds: 60 } },
  });
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const billingUrl = (teamId: string) => `/teams/${teamId}/billing`;
const withKey = (headers: Record<string, string>, key: string = randomUUID()) => ({ ...headers, 'idempotency-key': key });

/** A Team-18 team with an Owner, a Manager and `staff` staff members: `2 + staff` active members. */
async function setup(staff: number, shard?: 'A' | 'B') {
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  const people: Array<{ id: string; name: string }> = [];
  for (let i = 0; i < staff; i++) {
    const name = `Sam Staff ${i}`;
    const u = await app.seedUser(name);
    await app.addMember(teamId, u.id, 'staff');
    people.push({ id: u.id, name });
  }
  await seedActiveSubscription(db(teamId), teamId, { plan: 'team', seats: 18 }, { activationDate: '2031-06-01', requestedByUserId: owner.id });
  return { teamId, owner, manager, people, ownerH: bearer((await app.signIn(owner.id)).accessToken), managerH: bearer((await app.signIn(manager.id)).accessToken) };
}
type T = Awaited<ReturnType<typeof setup>>;

async function reduce(t: T, seats: number, selected: string[], opts: { acceptFallback?: boolean; plan?: string; key?: string; headers?: Record<string, string> } = {}) {
  return app.post(
    `${billingUrl(t.teamId)}/reductions`,
    { plan: opts.plan ?? 'team', seats, selectedMemberIds: selected, acceptFallback: opts.acceptFallback ?? false },
    withKey(opts.headers ?? t.ownerH, opts.key),
  );
}
const scheduledRows = (teamId: string) =>
  db(teamId).$queryRaw<Array<Record<string, any>>>`
    SELECT id::text AS id, status::text AS status, from_plan::text AS from_plan, from_seats, target_plan::text AS target_plan, target_seats, effective_on::text AS effective_on,
      selected_member_ids::text[] AS selected, fallback_accepted_at, fallback_wording, checked_at, check_detail, base_version
    FROM scheduled_changes WHERE team_id = ${teamId}::uuid ORDER BY created_at`;
const subscriptionOf = async (teamId: string) =>
  (await db(teamId).$queryRaw<Array<Record<string, any>>>`SELECT plan::text AS plan, seats, paid_basis_cents, version FROM subscriptions WHERE team_id = ${teamId}::uuid`)[0]!;
const ledgerCount = async (teamId: string) => Number((await db(teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM ledger_entries WHERE team_id = ${teamId}::uuid`)[0]!.n);
const boundaryRow = async (teamId: string) =>
  (await db(teamId).$queryRaw<Array<{ id: string; status: string; run_at: Date; available_at: Date; payload: any }>>`
    SELECT id::text AS id, status::text AS status, run_at, available_at, payload FROM work_rows WHERE kind = 'reduction_boundary' AND payload->>'teamId' = ${teamId}`)[0];

/** The period ends: the boundary row becomes due (the test's database clock is the real one), and the REAL work processor runs the REAL handler. */
async function runBoundary(teamId: string) {
  const row = (await boundaryRow(teamId))!;
  await db(teamId).$executeRaw`UPDATE work_rows SET run_at = NOW() - interval '1 minute' WHERE id = ${row.id}::uuid`;
  const lines: string[] = [];
  const processor = createWorkProcessor(app.raw, { reduction_boundary: createReductionBoundaryHandler({ shards: app.raw, logger: (l) => lines.push(l) }) });
  await processor({ id: `job-${row.id}-1`, data: { rowId: row.id, generation: 1, shard: shardFor(teamId) } } as any, undefined);
  return lines;
}

for (const shard of ['A', 'B'] as const) {
  test(`SCHEDULING on shard ${shard}: Team 18 to 3 seats with 5 members needs 2 chosen; the schedule changes nothing now (no ledger row, no entitlement change) and queues the boundary check for the period end`, async () => {
    const t = await setup(3, shard); // owner + manager + 3 staff = 5 active members
    const quote = await app.get(`${billingUrl(t.teamId)}/change-quote?plan=team&seats=3`, t.ownerH);
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.quote.effect, 'at_period_end');
    assert.equal(quote.body.quote.supported, true);
    assert.deepEqual({ ...quote.body.quote.reduction, fallbackWording: typeof quote.body.quote.reduction.fallbackWording }, { effectiveOn: '2031-07-01', activeMembers: 5, membersToDeactivate: 2, fallbackWording: 'string' });
    assert.match(quote.body.quote.headline, /2 people will become inactive on that date, and you choose who\./);

    const before = { sub: await subscriptionOf(t.teamId), ledger: await ledgerCount(t.teamId) };
    const [a, b, c] = t.people;

    const none = await reduce(t, 3, []);
    assert.equal(none.status, 422);
    assert.equal(none.body.error.code, 'selection_required');
    const oneOnly = await reduce(t, 3, [a!.id]);
    assert.equal(oneOnly.body.error.code, 'selection_required', 'fewer than needed');
    const tooMany = await reduce(t, 3, [a!.id, b!.id, c!.id]);
    assert.equal(tooMany.body.error.code, 'selection_invalid', 'more than needed');
    const owner = await reduce(t, 3, [t.owner.id, a!.id]);
    assert.equal(owner.status, 422);
    assert.equal(owner.body.error.code, 'selection_invalid', 'the Owner is never deactivated');
    const stranger = await reduce(t, 3, [(await app.seedUser('Stranger')).id, a!.id]);
    assert.equal(stranger.body.error.code, 'selection_invalid', 'not a member of this team');
    const twice = await reduce(t, 3, [a!.id, a!.id]);
    assert.equal(twice.body.error.code, 'selection_invalid', 'the same person twice');
    assert.equal((await scheduledRows(t.teamId)).length, 0, 'every refusal wrote nothing');

    const key = randomUUID();
    const ok = await reduce(t, 3, [a!.id, b!.id], { key });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'scheduled');
    assert.equal(ok.body.scheduledChange.status, 'scheduled');
    assert.equal(ok.body.scheduledChange.canCancel, true);
    assert.deepEqual(ok.body.scheduledChange.membersToDeactivate.map((m: { name: string }) => m.name).sort(), [a!.name, b!.name].sort());
    assert.equal(ok.body.scheduledChange.fallbackAccepted, false);

    const rows = await scheduledRows(t.teamId);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { status: rows[0]!.status, from: [rows[0]!.from_plan, rows[0]!.from_seats], to: [rows[0]!.target_plan, rows[0]!.target_seats], on: rows[0]!.effective_on, selected: [...rows[0]!.selected].sort(), fallback: rows[0]!.fallback_accepted_at, base: rows[0]!.base_version },
      { status: 'scheduled', from: ['team', 18], to: ['team', 3], on: '2031-07-01', selected: [a!.id, b!.id].sort(), fallback: null, base: 1 },
    );
    // Nothing moved now: no money, no entitlement change, nobody deactivated.
    assert.deepEqual({ sub: await subscriptionOf(t.teamId), ledger: await ledgerCount(t.teamId) }, before);
    const active = await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM memberships WHERE team_id = ${t.teamId}::uuid AND deactivated_at IS NULL`;
    assert.equal(Number(active[0]!.n), 5);

    // The boundary check is queued for 00:00 UTC on the effective date, written before it was enqueued (rule 9).
    const work = (await boundaryRow(t.teamId))!;
    assert.equal(work.run_at.toISOString(), '2031-07-01T00:00:00.000Z');
    assert.equal(work.available_at.toISOString(), '2031-07-01T00:02:00.000Z');
    assert.deepEqual(work.payload, { teamId: t.teamId, scheduledChangeId: rows[0]!.id });
    assert.ok(app.enqueued().some((e) => e.rowId === work.id && e.shard === shard), 'enqueued after commit');

    // The same key again: the stored answer, no second row.
    const replay = await reduce(t, 3, [a!.id, b!.id], { key });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.scheduledChange.id, rows[0]!.id);
    assert.equal((await scheduledRows(t.teamId)).length, 1);
    // The same key with another request is 422.
    assert.equal((await reduce(t, 3, [a!.id, c!.id], { key })).status, 422);

    // One reduction in flight per team.
    const second = await reduce(t, 4, [a!.id]);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'reduction_already_scheduled');

    // The overview shows it, with names.
    const overview = await app.get(billingUrl(t.teamId), t.ownerH);
    assert.equal(overview.body.scheduledChange.targetSeats, 3);
    assert.equal(overview.body.scheduledChange.effectiveOn, '2031-07-01');
    assert.match(overview.body.scheduledChange.message, /changes to Team, 3 seats on 2031-07-01\. Nothing is charged or refunded now\./);
  });
}

test('THE FALLBACK is stored only when the Owner accepts it, with the wording shown and the time', async () => {
  const t = await setup(3);
  const [a, b] = t.people;
  const accepted = await reduce(t, 3, [a!.id, b!.id], { acceptFallback: true });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const row = (await scheduledRows(t.teamId))[0]!;
  assert.ok(row.fallback_accepted_at instanceof Date);
  assert.equal(row.fallback_wording, accepted.body.scheduledChange.fallbackWording);
  assert.match(row.fallback_wording, /keep my current plan and price/);
  const quote = await app.get(`${billingUrl(t.teamId)}/change-quote?plan=team&seats=3`, t.ownerH);
  assert.equal(quote.body.quote.reduction.fallbackWording, row.fallback_wording, 'the wording the Owner saw is the wording stored');
});

test('A TEAM THAT ALREADY FITS needs nobody chosen: Team 18 to 15 with 3 members schedules with an empty selection, and choosing someone is refused', async () => {
  const t = await setup(1);
  assert.equal((await reduce(t, 15, [t.people[0]!.id])).body.error.code, 'selection_invalid');
  const ok = await reduce(t, 15, []);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual((await scheduledRows(t.teamId))[0]!.selected, []);
});

test('WHAT CANNOT BE SCHEDULED: nothing to change is 400, an increase or mixed change is 409, a team that has not activated is 409, and a payment in progress is 409', async () => {
  const t = await setup(1);
  const same = await reduce(t, 18, []);
  assert.equal(same.status, 400);
  assert.deepEqual(same.body.error.details, [{ path: 'plan', code: 'nothing_to_change' }]);
  assert.equal((await reduce(t, 20, [])).body.error.code, 'scheduled_change_unavailable', 'an increase is made through /changes');
  assert.equal((await reduce(t, 10, [], { plan: 'business' })).body.error.code, 'scheduled_change_unavailable', 'mixed');

  const owner = await app.seedUser('Unactivated Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id });
  const h = bearer((await app.signIn(owner.id)).accessToken);
  const notActive = await app.post(`${billingUrl(teamId)}/reductions`, { plan: 'team', seats: 3, selectedMemberIds: [], acceptFallback: false }, withKey(h));
  assert.equal(notActive.status, 409);
  assert.equal(notActive.body.error.code, 'not_activated');

  // A payment is open: every other subscription change waits (money.md).
  const paid = await app.post(`${billingUrl(t.teamId)}/changes`, { plan: 'team', seats: 30 }, withKey(t.ownerH));
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  const blocked = await reduce(t, 15, []);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'payment_in_progress');
});

test('INVITATIONS AND NEW MEMBERS MUST FIT THE FUTURE LIMIT: once Team 18 to 3 is scheduled with 2 chosen, a 4th person cannot be invited or accept; cancelling gives the room back', async () => {
  const t = await setup(3); // 5 active, 2 will go: 3 remain = the future limit
  const [a, b] = t.people;
  // An invitation made BEFORE the reduction: it fits the limit of 18 today.
  const early = await app.post(`/teams/${t.teamId}/invitations/links`, undefined, t.ownerH);
  assert.equal(early.status, 201, JSON.stringify(early.body));
  const earlyToken = await linkToken(early.body);

  assert.equal((await reduce(t, 3, [a!.id, b!.id])).status, 201);

  const email = `invitee-${randomUUID()}@example.com`;
  const invite = await app.post(`/teams/${t.teamId}/invitations`, { email, role: 'staff' }, t.ownerH);
  assert.equal(invite.status, 409, 'refused although the subscription still has 18 seats');
  assert.equal(invite.body.error.code, 'seat_limit_reached');
  const link = await app.post(`/teams/${t.teamId}/invitations/links`, undefined, t.ownerH);
  assert.equal(link.status, 409);

  const newcomer = await app.seedUser('Newcomer');
  const newcomerH = bearer((await app.signIn(newcomer.id)).accessToken);
  const refused = await app.post('/invitations/accept', { token: earlyToken }, newcomerH);
  assert.equal(refused.status, 409, 'the accept is the authority: the earlier invitation no longer fits');
  assert.equal(refused.body.error.code, 'seat_limit_reached');

  const cancel = await app.del(`${billingUrl(t.teamId)}/reductions/current`, t.ownerH);
  assert.equal(cancel.status, 204);
  assert.equal((await app.post(`/teams/${t.teamId}/invitations`, { email, role: 'staff' }, t.ownerH)).status, 201, 'the room is back');
});

/** The `<teamId>.<secret>` token inside an invite link answer. */
async function linkToken(body: { invitation?: { link?: string }; link?: string; token?: string }): Promise<string> {
  const link = body.invitation?.link ?? body.link ?? body.token ?? '';
  const match = /([0-9a-f-]{36}\.[A-Za-z0-9_-]+)/.exec(link);
  assert.ok(match, `no token in ${JSON.stringify(body)}`);
  return match[1]!;
}

test('CANCEL: allowed while scheduled (the row is cancelled, a new reduction can be made); cancelling nothing is 404; the boundary job then does nothing', async () => {
  const t = await setup(3);
  const [a, b] = t.people;
  assert.equal((await app.del(`${billingUrl(t.teamId)}/reductions/current`, t.ownerH)).status, 404, 'nothing scheduled');
  assert.equal((await reduce(t, 3, [a!.id, b!.id])).status, 201);
  assert.equal((await app.del(`${billingUrl(t.teamId)}/reductions/current`, t.ownerH)).status, 204);
  assert.equal((await scheduledRows(t.teamId))[0]!.status, 'cancelled');
  assert.equal((await app.get(billingUrl(t.teamId), t.ownerH)).body.scheduledChange, null);

  const lines = await runBoundary(t.teamId);
  assert.match(lines.join('\n'), /outcome=skipped detail=cancelled/);
  assert.equal((await scheduledRows(t.teamId))[0]!.status, 'cancelled', 'a cancelled change stays cancelled');

  // A new one is allowed now that the old one is no longer live.
  assert.equal((await reduce(t, 4, [a!.id])).status, 201);
  assert.equal((await scheduledRows(t.teamId)).length, 2);
});

test('THE BOUNDARY CHECK records READY when the remaining members fit; it applies NOTHING (no deactivation, no ledger row, entitlements unchanged); the Owner can no longer cancel; a replay is harmless', async () => {
  const t = await setup(3);
  const [a, b] = t.people;
  assert.equal((await reduce(t, 3, [a!.id, b!.id])).status, 201);
  const before = { sub: await subscriptionOf(t.teamId), ledger: await ledgerCount(t.teamId) };

  const lines = await runBoundary(t.teamId);
  assert.match(lines.join('\n'), /outcome=ready detail=active_after_3_target_3/);
  assert.doesNotMatch(lines.join('\n'), /NOTIFY_OWNER_PENDING/);
  const row = (await scheduledRows(t.teamId))[0]!;
  assert.equal(row.status, 'ready');
  assert.equal(row.check_detail, 'active_after_3_target_3');
  assert.ok(row.checked_at instanceof Date);
  assert.deepEqual({ sub: await subscriptionOf(t.teamId), ledger: await ledgerCount(t.teamId) }, before, 'P5 applies nothing');
  const deactivated = await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM memberships WHERE team_id = ${t.teamId}::uuid AND deactivated_at IS NOT NULL`;
  assert.equal(Number(deactivated[0]!.n), 0);

  const overview = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.equal(overview.body.scheduledChange.status, 'ready');
  assert.equal(overview.body.scheduledChange.canCancel, false);
  const cancel = await app.del(`${billingUrl(t.teamId)}/reductions/current`, t.ownerH);
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.error.code, 'scheduled_change_unavailable');
  assert.equal((await reduce(t, 4, [a!.id])).body.error.code, 'reduction_already_scheduled', 'a checked change still counts as the one in flight');

  // The processor does not hand a finished row to the handler again; but if the handler is run twice anyway (a lost acknowledgement), the first answer stands.
  const work = (await boundaryRow(t.teamId))!;
  const lines2: string[] = [];
  await createReductionBoundaryHandler({ shards: app.raw, logger: (l) => lines2.push(l) })({ row: { id: work.id, generation: 1, payload: work.payload } } as any);
  assert.match(lines2.join('\n'), /outcome=skipped detail=ready/);
  assert.equal((await scheduledRows(t.teamId))[0]!.checked_at!.getTime(), row.checked_at.getTime(), 'the first answer stands');
});

test('THE BOUNDARY CHECK records BLOCKED when too many members remain and nothing was accepted, and CONTINUING when the Owner accepted the fallback; both ask for the Owner\'s attention', async () => {
  for (const accepted of [false, true]) {
    const t = await setup(3);
    const [a, b] = t.people;
    assert.equal((await reduce(t, 3, [a!.id, b!.id], { acceptFallback: accepted })).status, 201);
    // Someone joined another way between the schedule and the boundary (a seat taken without an invitation).
    await app.addMember(t.teamId, (await app.seedUser('Late Joiner')).id, 'staff');

    const lines = (await runBoundary(t.teamId)).join('\n');
    const expected = accepted ? 'continuing' : 'blocked';
    assert.match(lines, new RegExp(`outcome=${expected} detail=active_after_4_target_3 NOTIFY_OWNER_PENDING`));
    const row = (await scheduledRows(t.teamId))[0]!;
    assert.equal(row.status, expected);
    assert.equal(row.check_detail, 'active_after_4_target_3');
    const overview = await app.get(billingUrl(t.teamId), t.ownerH);
    assert.equal(overview.body.scheduledChange.status, expected);
    assert.equal(overview.body.scheduledChange.canCancel, false);
    assert.match(overview.body.scheduledChange.message, accepted ? /current plan and price continue/ : /has not been applied and needs your attention/);
    assert.equal((await subscriptionOf(t.teamId)).seats, 18, 'nothing was applied');
  }
});

test('WHO MAY: only the Owner schedules or cancels (a Manager is 403, a stranger 404, no token 401), and a client cannot send a price', async () => {
  const t = await setup(2);
  const [a] = t.people;
  assert.equal((await reduce(t, 15, [], { headers: t.managerH })).status, 403);
  const stranger = bearer((await app.signIn((await app.seedUser('Stranger')).id)).accessToken);
  assert.equal((await reduce(t, 15, [], { headers: stranger })).status, 404);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/reductions`, { plan: 'team', seats: 15, selectedMemberIds: [], acceptFallback: false }, { 'idempotency-key': randomUUID() })).status, 401);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/reductions`, { plan: 'team', seats: 15, selectedMemberIds: [], acceptFallback: false, price: 1 }, withKey(t.ownerH))).status, 400);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/reductions`, { plan: 'team', seats: 15, selectedMemberIds: ['not-a-uuid'], acceptFallback: false }, withKey(t.ownerH))).status, 400);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/reductions`, { plan: 'team', seats: 15, selectedMemberIds: [], acceptFallback: false }, t.ownerH)).status, 400, 'the Idempotency-Key is required');
  assert.equal((await reduce(t, 15, [], { headers: t.ownerH })).status, 201);
  assert.equal((await app.del(`${billingUrl(t.teamId)}/reductions/current`, t.managerH)).status, 403);
  assert.equal((await app.get(billingUrl(t.teamId), t.managerH)).status, 403, 'the overview, and the scheduled change in it, is the Owner\'s');
  assert.equal((await scheduledRows(t.teamId)).length, 1);
  void a;
});

test('A DEACTIVATED MEMBER is not a member on any route (404, like a stranger), is not listed, and is not a seat', async () => {
  const t = await setup(2); // owner + manager + 2 staff = 4
  const [a] = t.people;
  const aH = bearer((await app.signIn(a!.id)).accessToken);
  assert.equal((await app.get(`/teams/${t.teamId}/members`, aH)).status, 200);

  await db(t.teamId).$executeRaw`UPDATE memberships SET deactivated_at = NOW() WHERE team_id = ${t.teamId}::uuid AND user_id = ${a!.id}::uuid`;
  const members = await app.get(`/teams/${t.teamId}/members`, t.ownerH);
  assert.equal(members.status, 200);
  assert.equal(members.body.members.some((m: { userId?: string; id?: string }) => (m.userId ?? m.id) === a!.id), false, 'not listed');
  const gone = await app.get(`/teams/${t.teamId}/members`, aH);
  assert.equal(gone.status, 404);
  assert.equal((await app.get(`/teams/${t.teamId}`, aH)).status, 404);
  const teams = await app.get('/teams', aH);
  assert.equal(teams.status, 200);
  assert.equal(JSON.stringify(teams.body).includes(t.teamId), false, 'the team is not in their list');

  // Not a seat: 4 members with one deactivated is 3 seats taken.
  const overview = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.equal(overview.body.members, 3);
  // The row is kept (deactivated, never deleted).
  const kept = await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM memberships WHERE team_id = ${t.teamId}::uuid AND user_id = ${a!.id}::uuid`;
  assert.equal(Number(kept[0]!.n), 1);
});
