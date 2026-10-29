import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { rebuildSubscription, type LedgerRow } from './ledger.js';
import { FakeStripe, checkoutEventBody, runStripeJobs, sendWebhook, signedHeaders } from './stripe.testkit.js';

// Activation end to end (ADR 0027): the real routes, the real webhook route, the real job processor, the TEST shards. Only Stripe itself is a fake
// (FakeStripe) and its events are signed with Stripe's own test-header generator. The ledger can never be deleted, so every test uses fresh random teams.
let app: TeamsTestApp;
let stripe: FakeStripe;
before(async () => {
  stripe = new FakeStripe();
  app = await startTeamsTestApp({ billing: { stripe } });
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const billingUrl = (teamId: string) => `/teams/${teamId}/billing`;
const withKey = (headers: Record<string, string>, key: string = randomUUID()) => ({ ...headers, 'idempotency-key': key });

async function setup(opts: { members?: number; shard?: 'A' | 'B' } = {}) {
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  for (let i = 0; i < (opts.members ?? 0); i++) await app.addMember(teamId, (await app.seedUser(`Staff ${i}`)).id, 'staff');
  const h = async (id: string) => bearer((await app.signIn(id)).accessToken);
  return { teamId, owner, manager, ownerH: await h(owner.id), managerH: await h(manager.id), h };
}
type T = Awaited<ReturnType<typeof setup>>;

async function activate(t: T, plan = 'team', seats = 9, key: string = randomUUID()) {
  const res = await app.post(`${billingUrl(t.teamId)}/activation`, { plan, seats }, withKey(t.ownerH, key));
  return { res, key, operationId: res.body?.operation?.id as string, checkoutUrl: res.body?.checkoutUrl as string };
}

async function operationRow(teamId: string, operationId: string) {
  const rows = await db(teamId).$queryRaw<Array<Record<string, any>>>`
    SELECT status::text AS status, quote_cents, stripe_checkout_session_id, stripe_payment_intent_id, review_reason, base_version, kind::text AS kind
    FROM payment_operations WHERE id = ${operationId}::uuid`;
  return rows[0]!;
}
const ledgerOf = (teamId: string) =>
  db(teamId).$queryRaw<Array<{ entry_type: string; sequence: number; amount_cents: number; plan: string | null; seats: number | null; paid_basis_after_cents: number | null; stripe_payment_intent_id: string | null; operation_id: string; period_id: string | null }>>`
    SELECT entry_type::text AS entry_type, sequence, amount_cents, plan::text AS plan, seats, paid_basis_after_cents, stripe_payment_intent_id, operation_id, period_id::text AS period_id
    FROM ledger_entries WHERE team_id = ${teamId}::uuid ORDER BY position`;
const subscriptionOf = async (teamId: string) =>
  (await db(teamId).$queryRaw<Array<Record<string, any>>>`SELECT plan::text AS plan, seats, paid_basis_cents, version, billing_anchor_day, current_period_id::text AS current_period_id FROM subscriptions WHERE team_id = ${teamId}::uuid`)[0];
const eventRow = async (eventId: string) =>
  (await app.raw.A.primary.$queryRaw<Array<{ outcome: string | null; processed: boolean; team_id: string | null; operation_id: string | null }>>`
    SELECT outcome, processed_at IS NOT NULL AS processed, team_id::text AS team_id, operation_id::text AS operation_id FROM stripe_events WHERE event_id = ${eventId}`)[0];
const eventCount = async (teamId: string) => Number((await app.raw.A.primary.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM stripe_events WHERE team_id = ${teamId}::uuid`)[0]!.n);

/** Sends a signed Checkout event for an operation and runs the jobs it queued, like the API and the worker would. */
async function deliver(t: T, operationId: string, sessionId: string, over: Partial<Parameters<typeof checkoutEventBody>[0]> = {}) {
  const before = app.enqueued().length;
  const payload = checkoutEventBody({ sessionId, teamId: t.teamId, operationId, amountTotal: 5000, ...over });
  const res = await sendWebhook(app.base, payload);
  const queued = app.enqueued().slice(before);
  await runStripeJobs(app.raw, queued);
  return { res, payload, eventId: JSON.parse(payload).id as string, queued };
}
const sessionOf = async (t: T, operationId: string) => (await operationRow(t.teamId, operationId)).stripe_checkout_session_id as string;

for (const shard of ['A', 'B'] as const) {
  test(`ACTIVATION on shard ${shard}: checkout -> verified webhook -> job -> ledger rows, subscription and a completed operation; the ledger rebuilds the subscription`, async () => {
    const t = await setup({ shard });
    const { res, operationId, checkoutUrl } = await activate(t, 'team', 9);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
    assert.deepEqual(res.body.operation, {
      id: operationId, kind: 'activation', status: 'awaiting_payment', plan: 'team', planName: 'Team', seats: 9, amountDisplay: '$50.00', expiresAt: res.body.operation.expiresAt,
    });

    // The frozen operation, and what was sent to Stripe: an integer amount WE calculated, the operation's own stable key, our ids in metadata.
    const frozen = await operationRow(t.teamId, operationId);
    assert.equal(frozen.status, 'open');
    assert.equal(frozen.quote_cents, 5000);
    assert.equal(frozen.base_version, 0);
    assert.equal(stripe.calls.at(-1)!.key, `op-${operationId}`);
    assert.equal(stripe.calls.at(-1)!.request.amountCents, 5000);
    assert.equal(stripe.calls.at(-1)!.request.teamId, t.teamId);
    assert.match(stripe.calls.at(-1)!.request.successUrl, new RegExp(`/checkout/return\\?operation=${operationId}$`));
    assert.match(stripe.calls.at(-1)!.request.cancelUrl, new RegExp(`/checkout/cancel\\?operation=${operationId}$`));
    // Nothing is applied by creating the session.
    assert.equal(await subscriptionOf(t.teamId), undefined);
    assert.deepEqual(await ledgerOf(t.teamId), []);

    const sessionId = await sessionOf(t, operationId);
    const delivered = await deliver(t, operationId, sessionId, { paymentIntent: 'pi_test_activation_1' });
    assert.equal(delivered.res.status, 200);
    assert.deepEqual(await eventRow(delivered.eventId), { outcome: 'applied', processed: true, team_id: t.teamId, operation_id: operationId });

    const ledger = await ledgerOf(t.teamId);
    assert.deepEqual(
      ledger.map((r) => [r.entry_type, r.amount_cents, r.plan, r.seats, r.paid_basis_after_cents, r.stripe_payment_intent_id]),
      [
        ['period_start', 0, 'team', 9, 5000, null],
        ['charge', 5000, null, null, null, 'pi_test_activation_1'],
      ],
    );
    const sub = await subscriptionOf(t.teamId);
    assert.deepEqual({ plan: sub!.plan, seats: sub!.seats, paid: sub!.paid_basis_cents, version: sub!.version }, { plan: 'team', seats: 9, paid: 5000, version: 1 });
    const done = await operationRow(t.teamId, operationId);
    assert.equal(done.status, 'completed');
    assert.equal(done.stripe_payment_intent_id, 'pi_test_activation_1');

    // Rebuildable from the ledger alone (AGENTS.md rule 8).
    const rows: LedgerRow[] = ledger.map((r) => ({ operationId: r.operation_id, entryType: r.entry_type as LedgerRow['entryType'], sequence: r.sequence, amountCents: r.amount_cents, periodId: r.period_id, plan: r.plan as LedgerRow['plan'], seats: r.seats, paidBasisAfterCents: r.paid_basis_after_cents }));
    const rebuilt = rebuildSubscription(rows);
    assert.deepEqual({ plan: rebuilt.plan, seats: rebuilt.seats, paidBasisCents: rebuilt.paidBasisCents, version: rebuilt.version, currentPeriodId: rebuilt.currentPeriodId }, { plan: sub!.plan, seats: sub!.seats, paidBasisCents: sub!.paid_basis_cents, version: sub!.version, currentPeriodId: sub!.current_period_id });

    // The server says paid; the overview shows the subscription with finished strings.
    const status = await app.get(`${billingUrl(t.teamId)}/operations/${operationId}`, t.ownerH);
    assert.equal(status.body.operation.status, 'paid');
    const overview = await app.get(billingUrl(t.teamId), t.ownerH);
    assert.equal(overview.body.activated, true);
    assert.equal(overview.body.subscription.monthlyDisplay, '$50.00');
    assert.equal(overview.body.seatLimit, 9);
  });
}

test('A REPLAYED WEBHOOK (the same event id, three times) writes no new rows', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'starter', 5);
  const sessionId = await sessionOf(t, operationId);
  const first = await deliver(t, operationId, sessionId, { amountTotal: 2000, paymentIntent: 'pi_test_replay' });
  assert.equal(first.res.status, 200);
  const ledgerBefore = await ledgerOf(t.teamId);
  assert.equal(ledgerBefore.length, 2);
  const workRowsBefore = Number((await app.raw.A.primary.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM work_rows WHERE kind = 'stripe_event' AND payload->>'teamId' = ${t.teamId}`)[0]!.n);

  const enqueuedBefore = app.enqueued().length;
  for (let i = 0; i < 3; i++) {
    const again = await sendWebhook(app.base, first.payload); // byte-for-byte the same delivery
    assert.equal(again.status, 200);
  }
  assert.equal(app.enqueued().length, enqueuedBefore, 'a processed event is acknowledged and never queued again');
  assert.deepEqual(await ledgerOf(t.teamId), ledgerBefore, 'no new ledger rows');
  assert.equal(await eventCount(t.teamId), 1, 'one inbox row for the one event id');
  const workRowsAfter = Number((await app.raw.A.primary.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM work_rows WHERE kind = 'stripe_event' AND payload->>'teamId' = ${t.teamId}`)[0]!.n);
  assert.equal(workRowsAfter, workRowsBefore, 'a repeated delivery makes no second work row');
  assert.equal((await subscriptionOf(t.teamId))!.version, 1);
});

test('TWO EVENTS FOR ONE PAYMENT (completed, then async_payment_succeeded) apply once: the second is a recorded no-op', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'starter', 5);
  const sessionId = await sessionOf(t, operationId);
  const one = await deliver(t, operationId, sessionId, { amountTotal: 2000, paymentIntent: 'pi_test_two_events' });
  const two = await deliver(t, operationId, sessionId, { type: 'checkout.session.async_payment_succeeded', amountTotal: 2000, paymentIntent: 'pi_test_two_events' });
  assert.equal((await eventRow(one.eventId))!.outcome, 'applied');
  assert.equal((await eventRow(two.eventId))!.outcome, 'duplicate');
  assert.equal((await ledgerOf(t.teamId)).length, 2, 'one set of ledger rows');
  assert.equal((await subscriptionOf(t.teamId))!.version, 1);
});

test('A DECLINED CARD applies nothing: Stripe sends no completed event, so the operation stays open and no ledger or subscription row exists', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  // The declined card (4000 0000 0000 0002) is refused on Stripe's page; the session stays open for another try and Stripe sends us NOTHING.
  // The nearest thing it can send is a session that is "complete" but not paid: that must apply nothing either.
  const unpaid = await deliver(t, operationId, await sessionOf(t, operationId), { paymentStatus: 'unpaid', amountTotal: 5000, paymentIntent: 'pi_test_unpaid' });
  assert.equal(unpaid.res.status, 200);
  assert.equal((await eventRow(unpaid.eventId))!.outcome, 'ignored');
  assert.equal((await operationRow(t.teamId, operationId)).status, 'open');
  assert.equal(await subscriptionOf(t.teamId), undefined);
  assert.deepEqual(await ledgerOf(t.teamId), []);
  assert.equal((await app.get(`${billingUrl(t.teamId)}/operations/${operationId}`, t.ownerH)).body.operation.status, 'awaiting_payment');

  // When the async payment then FAILS, the operation ends as failed and still nothing is applied.
  const failed = await deliver(t, operationId, await sessionOf(t, operationId), { type: 'checkout.session.async_payment_failed', paymentStatus: 'unpaid', amountTotal: 5000, paymentIntent: null });
  assert.equal((await eventRow(failed.eventId))!.outcome, 'applied');
  assert.equal((await operationRow(t.teamId, operationId)).status, 'failed');
  assert.equal((await app.get(`${billingUrl(t.teamId)}/operations/${operationId}`, t.ownerH)).body.operation.status, 'failed');
  assert.deepEqual(await ledgerOf(t.teamId), []);
  assert.equal(await subscriptionOf(t.teamId), undefined);
});

test('a session that expires unpaid ends the operation, and the team can start again', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const expired = await deliver(t, operationId, await sessionOf(t, operationId), { type: 'checkout.session.expired', paymentStatus: 'unpaid', paymentIntent: null, amountTotal: 5000 });
  assert.equal((await eventRow(expired.eventId))!.outcome, 'applied');
  assert.equal((await operationRow(t.teamId, operationId)).status, 'expired');
  assert.equal((await activate(t, 'team', 9)).res.status, 201, 'a new attempt is allowed');
});

test('MISMATCHES are recorded, not applied, and sent to human review: wrong amount, wrong currency, wrong team, wrong session, a missing payment id', async () => {
  const cases: Array<{ label: string; over: (t: T, sessionId: string) => Partial<Parameters<typeof checkoutEventBody>[0]>; reason: RegExp }> = [
    { label: 'wrong amount', over: () => ({ amountTotal: 4999 }), reason: /^amount_mismatch/ },
    { label: 'wrong currency', over: () => ({ amountTotal: 5000, currency: 'eur' }), reason: /^currency_mismatch/ },
    { label: 'wrong session', over: () => ({ amountTotal: 5000, sessionId: 'cs_test_someone_elses_session' }), reason: /^session_mismatch/ },
    { label: 'no payment id', over: () => ({ amountTotal: 5000, paymentIntent: null }), reason: /^payment_intent_missing/ },
  ];
  for (const c of cases) {
    const t = await setup();
    const { operationId } = await activate(t, 'team', 9);
    const sessionId = await sessionOf(t, operationId);
    const d = await deliver(t, operationId, sessionId, { paymentIntent: `pi_test_${randomUUID().slice(0, 8)}`, ...c.over(t, sessionId) });
    assert.equal(d.res.status, 200, c.label);
    assert.equal((await eventRow(d.eventId))!.outcome, 'review', c.label);
    const op = await operationRow(t.teamId, operationId);
    assert.equal(op.status, 'needs_review', c.label);
    assert.match(op.review_reason, c.reason, c.label);
    assert.equal(op.stripe_payment_intent_id, null, `${c.label}: the payment id is not stored on an unapplied operation`);
    assert.equal(await subscriptionOf(t.teamId), undefined, c.label);
    assert.deepEqual(await ledgerOf(t.teamId), [], c.label);
  }
});

test('WRONG TEAM: an event naming this operation under another team id finds nothing to apply and changes nothing', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const sessionId = await sessionOf(t, operationId);
  const other = randomUUID();
  const d = await deliver(t, operationId, sessionId, { teamId: other, amountTotal: 5000, paymentIntent: 'pi_test_wrong_team' });
  assert.equal(d.res.status, 200);
  assert.equal((await eventRow(d.eventId))!.outcome, 'review');
  assert.equal((await operationRow(t.teamId, operationId)).status, 'open', 'the real team operation is untouched');
  assert.equal(await subscriptionOf(t.teamId), undefined);
  assert.deepEqual(await ledgerOf(t.teamId), []);
  // This event names a team that does not exist, so the harness cleanup (by team) will not find it.
  await app.raw.A.primary.$executeRaw`DELETE FROM stripe_events WHERE event_id = ${d.eventId}`;
  await app.raw.A.primary.$executeRaw`DELETE FROM work_rows WHERE kind = 'stripe_event' AND payload->>'teamId' = ${other}`;
});

test('a payment for an operation that already ended, or already completed under another payment, is recorded and sent to review; nothing new is written', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const sessionId = await sessionOf(t, operationId);
  await db(t.teamId).$executeRaw`UPDATE payment_operations SET status = 'expired'::payment_operation_status WHERE id = ${operationId}::uuid`;
  const late = await deliver(t, operationId, sessionId, { amountTotal: 5000, paymentIntent: 'pi_test_late' });
  assert.equal((await eventRow(late.eventId))!.outcome, 'review');
  const op = await operationRow(t.teamId, operationId);
  assert.equal(op.status, 'needs_review');
  assert.match(op.review_reason, /^paid_after_expired/);
  assert.deepEqual(await ledgerOf(t.teamId), []);

  // Completed under one payment; a DIFFERENT payment arrives for it.
  const u = await setup();
  const { operationId: op2 } = await activate(u, 'starter', 5);
  const s2 = await sessionOf(u, op2);
  await deliver(u, op2, s2, { amountTotal: 2000, paymentIntent: 'pi_test_first_payment' });
  const ledgerAfterFirst = await ledgerOf(u.teamId);
  const extra = await deliver(u, op2, s2, { amountTotal: 2000, paymentIntent: 'pi_test_second_payment' });
  assert.equal((await eventRow(extra.eventId))!.outcome, 'review');
  assert.equal((await operationRow(u.teamId, op2)).status, 'completed', 'a completed operation stays completed');
  assert.equal((await operationRow(u.teamId, op2)).stripe_payment_intent_id, 'pi_test_first_payment');
  assert.deepEqual(await ledgerOf(u.teamId), ledgerAfterFirst);
});

test('a team that outgrew the seats while paying is not activated: members_exceed_seats goes to review', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'starter', 5);
  for (let i = 0; i < 4; i++) await app.addMember(t.teamId, (await app.seedUser(`Late ${i}`)).id, 'staff'); // now 6 members
  const d = await deliver(t, operationId, await sessionOf(t, operationId), { amountTotal: 2000, paymentIntent: 'pi_test_outgrown' });
  assert.equal((await eventRow(d.eventId))!.outcome, 'review');
  assert.match((await operationRow(t.teamId, operationId)).review_reason, /^members_exceed_seats/);
  assert.equal(await subscriptionOf(t.teamId), undefined);
});

test('CRASH after the team-shard transaction: the replay finds the operation complete and only finishes the inbox', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const first = await deliver(t, operationId, await sessionOf(t, operationId), { amountTotal: 5000, paymentIntent: 'pi_test_crash' });
  const ledgerBefore = await ledgerOf(t.teamId);
  // Undo only what the crash would have prevented: the inbox mark and the work row's completion.
  await app.raw.A.primary.$executeRaw`UPDATE stripe_events SET processed_at = NULL, outcome = NULL WHERE event_id = ${first.eventId}`;
  await app.raw.A.primary.$executeRaw`UPDATE work_rows SET status = 'pending'::work_status, claim_token = NULL, claim_expires_at = NULL, execution_attempts = 0 WHERE id = ${first.queued[0]!.rowId}::uuid`;
  assert.equal((await eventRow(first.eventId))!.processed, false);
  await runStripeJobs(app.raw, first.queued);
  assert.deepEqual(await eventRow(first.eventId), { outcome: 'duplicate', processed: true, team_id: t.teamId, operation_id: operationId });
  assert.deepEqual(await ledgerOf(t.teamId), ledgerBefore, 'no ledger row was written again');
  assert.equal((await operationRow(t.teamId, operationId)).status, 'completed');
});

test('an event recorded but not processed is put back on the queue when Stripe sends it again; a processed one is not', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const payload = checkoutEventBody({ sessionId: await sessionOf(t, operationId), teamId: t.teamId, operationId, amountTotal: 5000, paymentIntent: 'pi_test_redelivery' });
  const before = app.enqueued().length;
  assert.equal((await sendWebhook(app.base, payload)).status, 200); // recorded, enqueued, NOT run
  assert.equal(app.enqueued().length, before + 1);
  assert.equal((await sendWebhook(app.base, payload)).status, 200); // Stripe sends it again
  assert.equal(app.enqueued().length, before + 2, 'the recorded, unprocessed event was enqueued again');
  assert.equal(app.enqueued()[before]!.rowId, app.enqueued()[before + 1]!.rowId, 'the same work row');
  await runStripeJobs(app.raw, [app.enqueued()[before]!]);
  assert.equal((await sendWebhook(app.base, payload)).status, 200);
  assert.equal(app.enqueued().length, before + 2, 'a processed event is acknowledged and not enqueued');
  assert.equal(await eventCount(t.teamId), 1);
});

test('THE WEBHOOK IS VERIFIED BEFORE ANYTHING IS READ: a bad signature, no signature, a tampered body, another secret or non-JSON are 400 and record nothing', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const sessionId = await sessionOf(t, operationId);
  const payload = checkoutEventBody({ sessionId, teamId: t.teamId, operationId, amountTotal: 5000, paymentIntent: 'pi_test_forged' });
  const eventId = JSON.parse(payload).id as string;
  const good = signedHeaders(payload);
  const attempts: Array<[string, string, Record<string, string>]> = [
    ['no signature header', payload, { 'content-type': 'application/json' }],
    ['a garbage signature', payload, { ...good, 'stripe-signature': 'nonsense' }],
    ['a tampered body', payload.replace('5000', '1'), good],
    ['signed with another secret', payload, signedHeaders(payload, 'whsec_an_attacker_made_this_up')],
    ['not JSON', 'amount=5000', { ...good, 'content-type': 'application/x-www-form-urlencoded' }],
  ];
  const queuedBefore = app.enqueued().length;
  for (const [label, body, headers] of attempts) {
    const res = await sendWebhook(app.base, body, headers);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error.code, 'validation_failed', label);
  }
  assert.equal(app.enqueued().length, queuedBefore, 'nothing was queued');
  assert.equal(await eventCount(t.teamId), 0, 'nothing was recorded');
  assert.equal((await operationRow(t.teamId, operationId)).status, 'open');
  assert.deepEqual(await ledgerOf(t.teamId), []);
  // Logs before verification hold the request line and an outcome only: nothing from the body (the event id, the session, the payment).
  const logs = app.logLines().join('\n');
  assert.ok(!logs.includes(eventId) && !logs.includes(sessionId) && !logs.includes('pi_test_forged'), 'no event field reached a log line');
});

test('a LIVE-mode event is refused and never recorded, even when correctly signed', async () => {
  const t = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const payload = checkoutEventBody({ sessionId: await sessionOf(t, operationId), teamId: t.teamId, operationId, amountTotal: 5000, livemode: true });
  const res = await sendWebhook(app.base, payload);
  assert.equal(res.status, 400);
  assert.equal(await eventCount(t.teamId), 0);
  assert.ok(app.logLines().some((l) => l.includes('stripe_live_event_refused')), 'refusal is logged loudly');
});

test('events we do not act on are acknowledged and not recorded: another event type, or a Checkout Session this app did not make', async () => {
  const t = await setup();
  const other = checkoutEventBody({ type: 'payment_intent.succeeded', sessionId: 'pi_whatever', teamId: t.teamId, operationId: randomUUID() });
  const notOurs = checkoutEventBody({ sessionId: 'cs_test_not_ours', teamId: null, operationId: null, amountTotal: 100 });
  const queuedBefore = app.enqueued().length;
  assert.equal((await sendWebhook(app.base, other)).status, 200);
  assert.equal((await sendWebhook(app.base, notOurs)).status, 200);
  assert.equal(app.enqueued().length, queuedBefore);
  assert.equal(await eventCount(t.teamId), 0);
});

test('IDEMPOTENCY: the same key and request returns the stored answer (one operation, one Stripe session); the same key with another body is 422', async () => {
  const t = await setup();
  const key = randomUUID();
  const first = await activate(t, 'team', 9, key);
  assert.equal(first.res.status, 201);
  const callsBefore = stripe.calls.length;
  const again = await activate(t, 'team', 9, key);
  assert.equal(again.res.status, 200, 'the stored answer to a repeat');
  assert.deepEqual(again.res.body, first.res.body);
  assert.equal(stripe.calls.length, callsBefore, 'Stripe was not called again');
  const ops = await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM payment_operations WHERE team_id = ${t.teamId}::uuid`;
  assert.equal(Number(ops[0]!.n), 1, 'one operation');

  const different = await activate(t, 'team', 10, key);
  assert.equal(different.res.status, 422);
  assert.equal(different.res.body.error.code, 'idempotency_mismatch');
  const differentPlan = await activate(t, 'business', 9, key);
  assert.equal(differentPlan.res.status, 422);
  assert.equal(Number((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM payment_operations WHERE team_id = ${t.teamId}::uuid`)[0]!.n), 1);

  // A missing or malformed key is a validation error before anything else.
  const none = await app.post(`${billingUrl(t.teamId)}/activation`, { plan: 'team', seats: 9 }, t.ownerH);
  assert.equal(none.status, 400);
  const bad = await app.post(`${billingUrl(t.teamId)}/activation`, { plan: 'team', seats: 9 }, withKey(t.ownerH, 'not-a-uuid'));
  assert.equal(bad.status, 400);
});

test('ONE OPEN PAYMENT PER TEAM: a second attempt with a new key is 409 while one is open', async () => {
  const t = await setup();
  assert.equal((await activate(t, 'team', 9)).res.status, 201);
  const second = await activate(t, 'starter', 5);
  assert.equal(second.res.status, 409);
  assert.equal(second.res.body.error.code, 'payment_in_progress');
  assert.equal(Number((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM payment_operations WHERE team_id = ${t.teamId}::uuid`)[0]!.n), 1);
});

test('an operation nobody paid for before it expired no longer blocks the team', async () => {
  const t = await setup();
  const first = await activate(t, 'team', 9);
  await db(t.teamId).$executeRaw`UPDATE payment_operations SET expires_at = NOW() - interval '1 minute' WHERE id = ${first.operationId}::uuid`;
  assert.equal((await app.get(`${billingUrl(t.teamId)}/operations/${first.operationId}`, t.ownerH)).body.operation.status, 'expired', 'the server reports it as expired');
  const next = await activate(t, 'team', 9);
  assert.equal(next.res.status, 201);
  assert.equal((await operationRow(t.teamId, first.operationId)).status, 'expired');
});

test('cancel: backing out of Stripe ends the operation so the buyer can try again; an operation whose payment is being applied cannot be cancelled', async () => {
  const t = await setup();
  const first = await activate(t, 'team', 9);
  const cancelled = await app.post(`${billingUrl(t.teamId)}/operations/${first.operationId}/cancel`, {}, t.ownerH);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.operation.status, 'expired');
  assert.equal((await activate(t, 'team', 9)).res.status, 201);

  const u = await setup();
  const second = await activate(u, 'team', 9);
  // A verified event is recorded but its job has not run: the payment is "confirming".
  const payload = checkoutEventBody({ sessionId: await sessionOf(u, second.operationId), teamId: u.teamId, operationId: second.operationId, amountTotal: 5000, paymentIntent: 'pi_test_confirming' });
  await sendWebhook(app.base, payload);
  assert.equal((await app.get(`${billingUrl(u.teamId)}/operations/${second.operationId}`, u.ownerH)).body.operation.status, 'confirming');
  const refused = await app.post(`${billingUrl(u.teamId)}/operations/${second.operationId}/cancel`, {}, u.ownerH);
  assert.equal(refused.status, 409);
  assert.equal((await operationRow(u.teamId, second.operationId)).status, 'open');
});

test('STRIPE TIMES OUT after creating the session: nothing is recorded as paid or failed, and the SAME key resumes it to the same session', async () => {
  const t = await setup();
  const key = randomUUID();
  stripe.script.push('uncertain_after_create');
  const timedOut = await activate(t, 'team', 9, key);
  assert.equal(timedOut.res.status, 503);
  assert.equal(timedOut.res.body.error.code, 'service_unavailable');
  const rows = await db(t.teamId).$queryRaw<Array<{ id: string; status: string; stripe_checkout_session_id: string | null }>>`SELECT id::text AS id, status::text AS status, stripe_checkout_session_id FROM payment_operations WHERE team_id = ${t.teamId}::uuid`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'open', 'an unknown result is not recorded as a failure');
  assert.equal(rows[0]!.stripe_checkout_session_id, null);

  const resumed = await activate(t, 'team', 9, key);
  assert.equal(resumed.res.status, 201, JSON.stringify(resumed.res.body));
  assert.equal(resumed.operationId, rows[0]!.id, 'the same operation, not a second one');
  const calls = stripe.calls.filter((c) => c.key === `op-${rows[0]!.id}`);
  assert.equal(calls.length, 2, 'Stripe was called twice with the SAME idempotency key');
  assert.equal((await operationRow(t.teamId, rows[0]!.id)).stripe_checkout_session_id?.startsWith('cs_test_'), true);
  assert.equal(Number((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM payment_operations WHERE team_id = ${t.teamId}::uuid`)[0]!.n), 1);
});

test('STRIPE REFUSES the request: the operation is closed as failed so the team is not blocked, and the key answers the same', async () => {
  const t = await setup();
  const key = randomUUID();
  stripe.script.push('rejected');
  const refused = await activate(t, 'team', 9, key);
  assert.equal(refused.res.status, 503);
  const op = await db(t.teamId).$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM payment_operations WHERE team_id = ${t.teamId}::uuid`;
  assert.deepEqual(op.map((o) => o.status), ['failed']);
  assert.equal((await activate(t, 'team', 9, key)).res.status, 503, 'the same key gets the stored answer');
  assert.equal((await activate(t, 'team', 9)).res.status, 201, 'a new key starts again');
});

test('QUOTES are calculated by the server and come back as finished strings; invalid targets are refused', async () => {
  const t = await setup({ members: 2 });
  const quote = (plan: string, seats: string) => app.get(`${billingUrl(t.teamId)}/activation-quote?plan=${plan}&seats=${seats}`, t.ownerH);
  const starter = await quote('starter', '5');
  assert.equal(starter.status, 200);
  assert.equal(starter.body.quote.chargeTodayDisplay, '$20.00');
  assert.match(starter.body.quote.note, /charged in full/);
  assert.match(starter.body.quote.testModeNotice, /^This integration uses Stripe test mode only\./);
  assert.match(starter.body.quote.periodStartsOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await quote('team', '18')).body.quote.chargeTodayDisplay, '$59.00', 'Team with 18 seats: 5000 + 3 x 300');
  assert.equal((await quote('business', '50')).body.quote.chargeTodayDisplay, '$140.00', 'Business with 50 seats: 12000 + 10 x 200');
  assert.equal(JSON.stringify(starter.body).includes('Cents'), false, 'no raw cents reach the app');

  assert.equal((await quote('starter', '6')).status, 400, 'Starter never exceeds 5 seats');
  assert.equal((await quote('starter', '0')).status, 400);
  assert.equal((await quote('gold', '5')).status, 400);
  assert.equal((await quote('team', '10001')).status, 400);
  assert.equal((await quote('team', '1.5')).status, 400);
  const tooFew = await quote('starter', '2');
  assert.equal(tooFew.status, 422, 'three members cannot fit in two seats');
  assert.equal(tooFew.body.error.code, 'seats_below_members');
  assert.equal((await app.post(`${billingUrl(t.teamId)}/activation`, { plan: 'starter', seats: 2 }, withKey(t.ownerH))).status, 422);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/activation`, { plan: 'team', seats: 9, price: 1 }, withKey(t.ownerH))).status, 400, 'an unknown field (a client-sent price) is refused');
  assert.equal((await app.post(`${billingUrl(t.teamId)}/activation`, { plan: 'team', seats: 9, amount: 1 }, withKey(t.ownerH))).status, 400);
});

test('an activated team cannot activate again, and the overview shows the plans with prices already formatted', async () => {
  const t = await setup();
  const before = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.equal(before.status, 200);
  assert.equal(before.body.activated, false);
  assert.equal(before.body.seatLimit, 5, 'an unactivated team works within Starter');
  assert.deepEqual(before.body.plans.map((p: any) => [p.id, p.priceDisplay]), [['starter', '$20.00'], ['team', '$50.00'], ['business', '$120.00']]);
  assert.match(before.body.testModeNotice, /^This integration uses Stripe test mode only/);

  const { operationId } = await activate(t, 'starter', 5);
  await deliver(t, operationId, await sessionOf(t, operationId), { amountTotal: 2000, paymentIntent: 'pi_test_again' });
  const again = await activate(t, 'team', 9);
  assert.equal(again.res.status, 409);
  assert.equal(again.res.body.error.code, 'already_activated');
});

test('WHO MAY: only the Owner manages billing; a Manager is 403; a stranger and another team\'s operation are 404; no token is 401', async () => {
  const t = await setup();
  const u = await setup();
  const { operationId } = await activate(t, 'team', 9);
  const url = billingUrl(t.teamId);
  assert.equal((await app.get(url, t.managerH)).status, 403);
  assert.equal((await app.get(`${url}/activation-quote?plan=team&seats=9`, t.managerH)).status, 403);
  assert.equal((await app.post(`${url}/activation`, { plan: 'team', seats: 9 }, withKey(t.managerH))).status, 403);
  assert.equal((await app.get(`${url}/operations/${operationId}`, t.managerH)).status, 403);
  assert.equal((await app.post(`${url}/operations/${operationId}/cancel`, {}, t.managerH)).status, 403);
  assert.equal((await operationRow(t.teamId, operationId)).status, 'open', 'a refused cancel changed nothing');

  assert.equal((await app.get(url, u.ownerH)).status, 404, "another team's Owner cannot see this team's billing");
  assert.equal((await app.post(`${url}/activation`, { plan: 'team', seats: 9 }, withKey(u.ownerH))).status, 404);
  // The same Owner asking for this team's operation through their OWN team: it is not theirs, so it does not exist.
  assert.equal((await app.get(`${billingUrl(u.teamId)}/operations/${operationId}`, u.ownerH)).status, 404);
  assert.equal((await app.post(`${billingUrl(u.teamId)}/operations/${operationId}/cancel`, {}, u.ownerH)).status, 404);
  assert.equal((await operationRow(t.teamId, operationId)).status, 'open');

  assert.equal((await app.get(url)).status, 401);
  assert.equal((await app.post(`${url}/activation`, { plan: 'team', seats: 9 }, { 'idempotency-key': randomUUID() })).status, 401);
  assert.equal((await app.get(`${url}/operations/not-a-uuid`, t.ownerH)).status, 400);
});

test('the team view tells only the Owner to offer billing', async () => {
  const t = await setup();
  assert.equal((await app.get(`/teams/${t.teamId}`, t.ownerH)).body.canManageBilling, true);
  assert.equal((await app.get(`/teams/${t.teamId}`, t.managerH)).body.canManageBilling, false);
});

test('REDACTION: no log line carries the checkout URL, the session or the payment id', async () => {
  const t = await setup();
  const { operationId, checkoutUrl } = await activate(t, 'team', 9);
  const sessionId = await sessionOf(t, operationId);
  await deliver(t, operationId, sessionId, { amountTotal: 5000, paymentIntent: 'pi_test_log_check' });
  const logs = app.logLines().join('\n');
  for (const secret of [checkoutUrl, sessionId, 'pi_test_log_check']) assert.ok(!logs.includes(secret), `a log line contains ${secret.slice(0, 12)}...`);
});
