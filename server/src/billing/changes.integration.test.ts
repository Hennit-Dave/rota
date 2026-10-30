import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { rebuildSubscription, type LedgerRow } from './ledger.js';
import type { Entitlements } from './plans.js';
import { FakeStripe, checkoutEventBody, runStripeJobs, sendWebhook } from './stripe.testkit.js';
import { seedActiveSubscription } from './testkit.js';

// Plan and seat changes end to end (ADR 0028): the real routes, the real webhook route, the real job processor, the TEST shards. Only Stripe is a fake.
// "Now" is pinned (the clock below) so a test can sit on a chosen day of a 30-day period: seeded teams activated on 2031-06-01 are in 2031-06-01 to
// 2031-07-01, so 2031-06-19 is day 19 with 12 days left, and 2031-06-21 has 10. Ledger rows can never be deleted: every test uses fresh random teams.
/** Payment ids are unique per RUN: operations and ledger rows can never be deleted (ADR 0026), so a fixed id would collide with the last run's rows on the same test shard. */
const RUN = randomUUID().slice(0, 8);
const pi = (name: string) => `pi_test_${name}_${RUN}`;

let app: TeamsTestApp;
let stripe: FakeStripe;
let clock = new Date('2031-06-19T10:00:00.000Z');
const at = (iso: string) => void (clock = new Date(iso));
before(async () => {
  stripe = new FakeStripe();
  app = await startTeamsTestApp({ billing: { stripe, now: () => clock } });
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const billingUrl = (teamId: string) => `/teams/${teamId}/billing`;
const withKey = (headers: Record<string, string>, key: string = randomUUID()) => ({ ...headers, 'idempotency-key': key });
const team = (seats: number): Entitlements => ({ plan: 'team', seats });
const business = (seats: number): Entitlements => ({ plan: 'business', seats });

async function setup(seed: Entitlements | null, opts: { shard?: 'A' | 'B' } = {}) {
  at('2031-06-19T10:00:00.000Z');
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  if (seed) await seedActiveSubscription(db(teamId), teamId, seed, { activationDate: '2031-06-01', requestedByUserId: owner.id });
  const h = async (id: string) => bearer((await app.signIn(id)).accessToken);
  return { teamId, owner, ownerH: await h(owner.id), managerH: await h(manager.id), h };
}
type T = Awaited<ReturnType<typeof setup>>;

const quote = (t: T, plan: string, seats: number) => app.get(`${billingUrl(t.teamId)}/change-quote?plan=${plan}&seats=${seats}`, t.ownerH);
async function change(t: T, plan: string, seats: number, key: string = randomUUID()) {
  const res = await app.post(`${billingUrl(t.teamId)}/changes`, { plan, seats }, withKey(t.ownerH, key));
  return { res, key, operationId: res.body?.operation?.id as string };
}

const operationRows = (teamId: string) =>
  db(teamId).$queryRaw<Array<Record<string, any>>>`
    SELECT id::text AS id, kind::text AS kind, status::text AS status, base_version, from_plan::text AS from_plan, from_seats, apply_plan::text AS apply_plan, apply_seats,
      period_days, remaining_days, paid_basis_before_cents, gross_charge_cents, credit_cents, quote_cents, paid_basis_after_cents, stripe_payment_intent_id,
      stripe_checkout_session_id, review_reason
    FROM payment_operations WHERE team_id = ${teamId}::uuid ORDER BY created_at`;
const operationRow = async (teamId: string, id: string) => (await operationRows(teamId)).find((r) => r.id === id)!;
const ledgerOf = (teamId: string) =>
  db(teamId).$queryRaw<Array<{ entry_type: string; sequence: number; amount_cents: number; plan: string | null; seats: number | null; paid_basis_after_cents: number | null; stripe_payment_intent_id: string | null; operation_id: string; period_id: string | null }>>`
    SELECT entry_type::text AS entry_type, sequence, amount_cents, plan::text AS plan, seats, paid_basis_after_cents, stripe_payment_intent_id, operation_id::text AS operation_id, period_id::text AS period_id
    FROM ledger_entries WHERE team_id = ${teamId}::uuid ORDER BY position`;
const subscriptionOf = async (teamId: string) =>
  (await db(teamId).$queryRaw<Array<Record<string, any>>>`SELECT plan::text AS plan, seats, paid_basis_cents, version FROM subscriptions WHERE team_id = ${teamId}::uuid`)[0]!;
const eventOutcome = async (eventId: string) =>
  (await app.raw.A.primary.$queryRaw<Array<{ outcome: string | null }>>`SELECT outcome FROM stripe_events WHERE event_id = ${eventId}`)[0]?.outcome;

/** Sends a signed Checkout event for an operation and runs the jobs it queued, like the API and the worker would. */
async function pay(t: T, operationId: string, amountTotal: number, over: Partial<Parameters<typeof checkoutEventBody>[0]> = {}) {
  const before = app.enqueued().length;
  const sessionId = (await operationRow(t.teamId, operationId)).stripe_checkout_session_id as string;
  const payload = checkoutEventBody({ sessionId, teamId: t.teamId, operationId, amountTotal, paymentIntent: `pi_test_${randomUUID().slice(0, 12)}`, ...over });
  const res = await sendWebhook(app.base, payload);
  await runStripeJobs(app.raw, app.enqueued().slice(before));
  return { res, eventId: JSON.parse(payload).id as string };
}

const toLedgerRows = (rows: Awaited<ReturnType<typeof ledgerOf>>): LedgerRow[] =>
  rows.map((r) => ({ operationId: r.operation_id, entryType: r.entry_type as LedgerRow['entryType'], sequence: r.sequence, amountCents: r.amount_cents, periodId: r.period_id, plan: r.plan as LedgerRow['plan'], seats: r.seats, paidBasisAfterCents: r.paid_basis_after_cents }));

for (const shard of ['A', 'B'] as const) {
  test(`PAID CHANGE on shard ${shard}: Team 15 to 18 seats with 12 days left is $3.60: quote, frozen operation, verified webhook, credit and charge rows, version 2, rebuilt from the ledger`, async () => {
    const t = await setup(team(15), { shard });
    const q = await quote(t, 'team', 18);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.quote.effect, 'after_payment');
    assert.equal(q.body.quote.supported, true);
    assert.equal(q.body.quote.chargeTodayDisplay, '$3.60');
    assert.equal(q.body.quote.nextRenewalDisplay, '$59.00', 'Team with 18 seats: 5000 + 3 x 300');
    assert.equal(q.body.quote.remainingDays, 12);
    assert.equal(q.body.quote.periodEndsOn, '2031-07-01');
    assert.match(q.body.quote.headline, /charged \$3\.60 today for the 12 days left/);
    assert.equal(JSON.stringify(q.body).includes('Cents'), false, 'no raw cents reach the app');

    const c = await change(t, 'team', 18);
    assert.equal(c.res.status, 201, JSON.stringify(c.res.body));
    assert.equal(c.res.body.status, 'payment_required');
    assert.equal(c.res.body.operation.kind, 'change');
    assert.equal(c.res.body.operation.amountDisplay, '$3.60');
    assert.match(c.res.body.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);

    const frozen = await operationRow(t.teamId, c.operationId);
    assert.deepEqual(
      { kind: frozen.kind, status: frozen.status, base: frozen.base_version, from: [frozen.from_plan, frozen.from_seats], to: [frozen.apply_plan, frozen.apply_seats], days: [frozen.period_days, frozen.remaining_days], basisBefore: frozen.paid_basis_before_cents, gross: frozen.gross_charge_cents, credit: frozen.credit_cents, quote: frozen.quote_cents, basisAfter: frozen.paid_basis_after_cents },
      { kind: 'change', status: 'open', base: 1, from: ['team', 15], to: ['team', 18], days: [30, 12], basisBefore: 5000, gross: 2360, credit: 2000, quote: 360, basisAfter: 5900 },
    );
    assert.equal(stripe.calls.at(-1)!.request.amountCents, 360, 'Stripe is asked for the amount WE calculated');
    assert.equal(stripe.calls.at(-1)!.key, `op-${c.operationId}`);
    // Nothing is applied by creating the session.
    assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'team', seats: 15, paid_basis_cents: 5000, version: 1 });

    const paid = await pay(t, c.operationId, 360);
    assert.equal(paid.res.status, 200);
    assert.equal(await eventOutcome(paid.eventId), 'applied');
    assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'team', seats: 18, paid_basis_cents: 5900, version: 2 });
    assert.equal((await operationRow(t.teamId, c.operationId)).status, 'completed');

    const ledger = await ledgerOf(t.teamId);
    const mine = ledger.filter((r) => r.operation_id === c.operationId);
    assert.deepEqual(
      mine.map((r) => [r.entry_type, r.amount_cents, r.plan, r.seats, r.paid_basis_after_cents]),
      [['credit', -2000, null, null, null], ['charge', 2360, null, null, null], ['entitlement_change', 0, 'team', 18, 5900]],
    );
    assert.equal(mine.reduce((sum, r) => sum + r.amount_cents, 0), 360, 'credit plus charge is the payment');
    const rebuilt = rebuildSubscription(toLedgerRows(ledger));
    assert.deepEqual({ plan: rebuilt.plan, seats: rebuilt.seats, paidBasisCents: rebuilt.paidBasisCents, version: rebuilt.version }, { plan: 'team', seats: 18, paidBasisCents: 5900, version: 2 });

    assert.equal((await app.get(`${billingUrl(t.teamId)}/operations/${c.operationId}`, t.ownerH)).body.operation.status, 'paid');
    const history = await app.get(`${billingUrl(t.teamId)}/history`, t.ownerH);
    assert.equal(history.status, 200);
    assert.equal(history.body.hasMore, false);
    assert.deepEqual(history.body.history.map((e: any) => [e.title, e.detail, e.netDisplay]), [['Plan or seats changed', 'Team · 18 seats', '+$3.60'], ['Subscription activated', 'Team · 15 seats', '+$50.00']]);
    assert.deepEqual(history.body.history[0].lines, [{ label: 'Credit', amountDisplay: '−$20.00' }, { label: 'Charge', amountDisplay: '+$23.60' }]);
    assert.equal((await app.get(billingUrl(t.teamId), t.ownerH)).body.openOperation, null);
  });
}

test('SEATS INSIDE THE ALLOWANCE (Team 12 to 15, 12 days left) apply NOW with no charge: one ledger row, version 2, paid basis unchanged, Stripe never called', async () => {
  const t = await setup(team(12));
  const q = await quote(t, 'team', 15);
  assert.equal(q.body.quote.effect, 'now');
  assert.equal(q.body.quote.chargeTodayDisplay, null);
  const calls = stripe.calls.length;
  const c = await change(t, 'team', 15);
  assert.equal(c.res.status, 201, JSON.stringify(c.res.body));
  assert.equal(c.res.body.status, 'applied');
  assert.equal(c.res.body.change.seats, 15);
  assert.equal(stripe.calls.length, calls, 'no payment, no Stripe call');
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'team', seats: 15, paid_basis_cents: 5000, version: 2 });
  assert.equal((await operationRows(t.teamId)).filter((o) => o.kind === 'change').length, 0, 'no payment operation exists');
  const ledger = await ledgerOf(t.teamId);
  assert.deepEqual(ledger.slice(-1).map((r) => [r.entry_type, r.amount_cents, r.plan, r.seats, r.paid_basis_after_cents, r.stripe_payment_intent_id]), [['entitlement_change', 0, 'team', 15, 5000, null]]);
  const rebuilt = rebuildSubscription(toLedgerRows(ledger));
  assert.deepEqual({ seats: rebuilt.seats, paidBasisCents: rebuilt.paidBasisCents, version: rebuilt.version }, { seats: 15, paidBasisCents: 5000, version: 2 });
  const history = await app.get(`${billingUrl(t.teamId)}/history`, t.ownerH);
  assert.deepEqual([history.body.history[0].title, history.body.history[0].netDisplay], ['Plan or seats changed', 'No charge']);
});

test('UNDER STRIPE\'S MINIMUM: Team 15 to 16 with 1 day left (10 cents) applies now, free, paid basis stays 5000; 4 days (40 cents) too; 5 days (exactly 50 cents) is paid', async () => {
  const quoteOn = async (t: T, iso: string) => (at(iso), (await quote(t, 'team', 16)).body.quote);
  const t = await setup(team(15));
  const one = await quoteOn(t, '2031-06-30T10:00:00.000Z');
  assert.equal(one.remainingDays, 1);
  assert.equal(one.effect, 'now');
  assert.match(one.headline, /less than Stripe’s \$0\.50 minimum/);
  assert.equal((await quoteOn(t, '2031-06-27T10:00:00.000Z')).effect, 'now', '4 days left: 40 cents');
  const five = await quoteOn(t, '2031-06-26T10:00:00.000Z');
  assert.equal(five.effect, 'after_payment', '5 days left: exactly 50 cents');
  assert.equal(five.chargeTodayDisplay, '$0.50');

  at('2031-06-30T10:00:00.000Z');
  const c = await change(t, 'team', 16);
  assert.equal(c.res.status, 201, JSON.stringify(c.res.body));
  assert.equal(c.res.body.status, 'applied');
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'team', seats: 16, paid_basis_cents: 5000, version: 2 });
  assert.equal((await ledgerOf(t.teamId)).filter((r) => r.entry_type === 'charge').length, 1, 'only the activation charge: the 10 cents is never collected');
});

test('THE money.md CHAIN: Team 50 to Business 50 is free now; Business 50 to 55 is free now; Business 55 to 60 with 10 days left charges 167 and raises the paid basis to 16000', async () => {
  const t = await setup(team(50)); // monthly 15500
  at('2031-06-21T10:00:00.000Z'); // day 21: 10 days left
  const first = await change(t, 'business', 50);
  assert.equal(first.res.body.status, 'applied', JSON.stringify(first.res.body));
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'business', seats: 50, paid_basis_cents: 15500, version: 2 }, 'cheaper upgrade: the plan changes, the paid basis stays');
  const second = await change(t, 'business', 55);
  assert.equal(second.res.body.status, 'applied', JSON.stringify(second.res.body));
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'business', seats: 55, paid_basis_cents: 15500, version: 3 }, '15000 is inside what the period was paid at');

  const q = await quote(t, 'business', 60);
  assert.equal(q.body.quote.remainingDays, 10);
  assert.equal(q.body.quote.chargeTodayDisplay, '$1.67');
  const third = await change(t, 'business', 60);
  assert.equal(third.res.status, 201, JSON.stringify(third.res.body));
  const frozen = await operationRow(t.teamId, third.operationId);
  assert.deepEqual([frozen.gross_charge_cents, frozen.credit_cents, frozen.quote_cents, frozen.base_version, frozen.paid_basis_before_cents], [5333, 5166, 167, 3, 15500]);
  await pay(t, third.operationId, 167);
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'business', seats: 60, paid_basis_cents: 16000, version: 4 });
  const rebuilt = rebuildSubscription(toLedgerRows(await ledgerOf(t.teamId)));
  assert.deepEqual({ plan: rebuilt.plan, seats: rebuilt.seats, paidBasisCents: rebuilt.paidBasisCents, version: rebuilt.version }, { plan: 'business', seats: 60, paidBasisCents: 16000, version: 4 });
});

test('A DECREASE, A MIXED CHANGE AND "NOTHING" ARE REFUSED, and nothing is written: 409 scheduled_change_unavailable, 422 nothing_to_change', async () => {
  const t = await setup(team(18));
  const before = { sub: await subscriptionOf(t.teamId), ledger: (await ledgerOf(t.teamId)).length, ops: (await operationRows(t.teamId)).length };
  for (const [plan, seats] of [['team', 15], ['starter', 5], ['business', 10]] as const) {
    const q = await quote(t, plan, seats);
    assert.equal(q.body.quote.supported, false, `${plan} ${seats}`);
    assert.match(q.body.quote.headline, /Reductions are not available yet/);
    const c = await change(t, plan, seats);
    assert.equal(c.res.status, 409, `${plan} ${seats}: ${JSON.stringify(c.res.body)}`);
    assert.equal(c.res.body.error.code, 'scheduled_change_unavailable');
  }
  const same = await change(t, 'team', 18);
  assert.equal(same.res.status, 400, 'same plan and seats');
  assert.equal(same.res.body.error.code, 'validation_failed');
  assert.deepEqual(same.res.body.error.details, [{ path: 'plan', code: 'nothing_to_change' }]);
  assert.deepEqual({ sub: await subscriptionOf(t.teamId), ledger: (await ledgerOf(t.teamId)).length, ops: (await operationRows(t.teamId)).length }, before);
  assert.equal((await change(t, 'starter', 6)).res.status, 400, 'Starter never exceeds 5 seats');
  assert.equal((await app.post(`${billingUrl(t.teamId)}/changes`, { plan: 'team', seats: 20, price: 1 }, withKey(t.ownerH))).status, 400, 'an unknown field (a client-sent price) is refused');
});

test('THE PERIOD\'S EDGES: at or after the end every change is 409 period_ended; in the last 31 minutes a PAID change is 409 period_ending, a free one still applies', async () => {
  const t = await setup(team(15));
  at('2031-07-01T00:00:00.000Z');
  for (const res of [await quote(t, 'team', 30), (await change(t, 'team', 30)).res]) {
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'period_ended');
  }
  at('2031-06-30T23:30:00.000Z'); // 30 minutes before the end
  const paid = await change(t, 'team', 30); // Team 15 to 30 on the last day: 150 cents, so genuinely paid
  assert.equal(paid.res.status, 409);
  assert.equal(paid.res.body.error.code, 'period_ending');
  assert.equal((await operationRows(t.teamId)).filter((o) => o.kind === 'change').length, 0, 'no operation was frozen');
  at('2031-06-30T23:28:00.000Z'); // 32 minutes before the end: allowed
  assert.equal((await change(t, 'team', 30)).res.status, 201);
  const u = await setup(team(12));
  at('2031-06-30T23:50:00.000Z');
  assert.equal((await change(u, 'team', 15)).res.body.status, 'applied', 'a change that costs nothing is not affected by the cut-off');
});

test('a team that has not activated has no change to make: 409 not_activated', async () => {
  const t = await setup(null);
  for (const res of [await quote(t, 'team', 9), (await change(t, 'team', 9)).res]) {
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'not_activated');
  }
});

test('IDEMPOTENCY: the same key returns the stored answer (one operation, one Stripe session, one ledger row); another body with the key is 422', async () => {
  const t = await setup(team(15));
  const key = randomUUID();
  const first = await change(t, 'team', 18, key);
  assert.equal(first.res.status, 201);
  const calls = stripe.calls.length;
  const again = await change(t, 'team', 18, key);
  assert.equal(again.res.status, 200);
  assert.deepEqual(again.res.body, first.res.body);
  assert.equal(stripe.calls.length, calls, 'Stripe was not called again');
  assert.equal((await operationRows(t.teamId)).filter((o) => o.kind === 'change').length, 1);
  const different = await change(t, 'team', 19, key);
  assert.equal(different.res.status, 422);
  assert.equal(different.res.body.error.code, 'idempotency_mismatch');

  const u = await setup(team(12));
  const immediateKey = randomUUID();
  const one = await change(u, 'team', 15, immediateKey);
  const two = await change(u, 'team', 15, immediateKey);
  assert.deepEqual([one.res.status, two.res.status], [201, 200]);
  assert.deepEqual(two.res.body, one.res.body);
  assert.equal((await subscriptionOf(u.teamId)).version, 2, 'applied once');
  assert.equal((await ledgerOf(u.teamId)).filter((r) => r.entry_type === 'entitlement_change').length, 1);
  assert.equal((await app.post(`${billingUrl(u.teamId)}/changes`, { plan: 'team', seats: 16 }, u.ownerH)).status, 400, 'a missing Idempotency-Key is refused');
});

test('ONE OPEN PAYMENT PER TEAM: while a paid change is open every other change is 409, the free ones too; the overview shows the open payment', async () => {
  const t = await setup(team(15));
  const first = await change(t, 'team', 18);
  assert.equal(first.res.status, 201);
  for (const [plan, seats] of [['team', 20], ['business', 15], ['team', 15 + 1]] as const) {
    const c = await change(t, plan, seats);
    assert.equal(c.res.status, 409, `${plan} ${seats}`);
    assert.equal(c.res.body.error.code, 'payment_in_progress');
  }
  assert.equal((await operationRows(t.teamId)).filter((o) => o.kind === 'change').length, 1);
  const overview = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.equal(overview.body.openOperation.id, first.operationId);
  assert.equal(overview.body.openOperation.status, 'awaiting_payment');
  assert.equal(overview.body.openOperation.kind, 'change');
});

test('VERSION MISMATCH: the subscription changed after the quote, so the payment is recorded, NOT applied, and the operation goes to review', async () => {
  const t = await setup(team(15));
  const c = await change(t, 'team', 18);
  await db(t.teamId).$executeRaw`UPDATE subscriptions SET version = version + 1 WHERE team_id = ${t.teamId}::uuid`; // another change landed in between
  const ledgerBefore = await ledgerOf(t.teamId);
  const paid = await pay(t, c.operationId, 360);
  assert.equal(paid.res.status, 200);
  assert.equal(await eventOutcome(paid.eventId), 'review');
  const op = await operationRow(t.teamId, c.operationId);
  assert.equal(op.status, 'needs_review');
  assert.match(op.review_reason, /^version_mismatch/);
  assert.equal(op.stripe_payment_intent_id, null);
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'team', seats: 15, paid_basis_cents: 5000, version: 2 }, 'nothing was applied');
  assert.deepEqual(await ledgerOf(t.teamId), ledgerBefore);
});

test('a change payment is matched like activation: wrong amount, wrong currency or an unpaid session apply nothing; a second event for the same payment is a no-op', async () => {
  const t = await setup(team(15));
  const c = await change(t, 'team', 18);
  const unpaid = await pay(t, c.operationId, 360, { paymentStatus: 'unpaid', paymentIntent: pi('unpaid_change') });
  assert.equal(await eventOutcome(unpaid.eventId), 'ignored');
  assert.equal((await operationRow(t.teamId, c.operationId)).status, 'open');
  const wrong = await pay(t, c.operationId, 359);
  assert.equal(await eventOutcome(wrong.eventId), 'review');
  assert.match((await operationRow(t.teamId, c.operationId)).review_reason, /^amount_mismatch/);
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'team', seats: 15, paid_basis_cents: 5000, version: 1 });

  const u = await setup(team(15));
  const d = await change(u, 'team', 18);
  const cur = await pay(u, d.operationId, 360, { currency: 'eur' });
  assert.equal(await eventOutcome(cur.eventId), 'review');
  assert.match((await operationRow(u.teamId, d.operationId)).review_reason, /^currency_mismatch/);

  const v = await setup(team(15));
  const e = await change(v, 'team', 18);
  const one = await pay(v, e.operationId, 360, { paymentIntent: pi('same_change_payment') });
  const two = await pay(v, e.operationId, 360, { type: 'checkout.session.async_payment_succeeded', paymentIntent: pi('same_change_payment') });
  assert.equal(await eventOutcome(one.eventId), 'applied');
  assert.equal(await eventOutcome(two.eventId), 'duplicate');
  assert.equal((await subscriptionOf(v.teamId)).version, 2, 'applied once');
  assert.equal((await ledgerOf(v.teamId)).filter((r) => r.entry_type === 'credit').length, 1);
});

test('OUR ENGINE IS THE LAST WORD: a frozen operation whose numbers do not match what the engine derives is sent to review, not applied', async () => {
  const t = await setup(team(15));
  const c = await change(t, 'team', 18);
  await db(t.teamId).$executeRaw`UPDATE payment_operations SET paid_basis_after_cents = 9999 WHERE id = ${c.operationId}::uuid`;
  const paid = await pay(t, c.operationId, 360);
  assert.equal(await eventOutcome(paid.eventId), 'review');
  assert.match((await operationRow(t.teamId, c.operationId)).review_reason, /^quote_does_not_match_engine/);
  assert.deepEqual(await subscriptionOf(t.teamId), { plan: 'team', seats: 15, paid_basis_cents: 5000, version: 1 });
});

test('WHO MAY: only the Owner changes the plan or reads the history; a Manager is 403, a stranger 404, no token 401', async () => {
  const t = await setup(team(15));
  const u = await setup(team(15));
  const url = billingUrl(t.teamId);
  assert.equal((await app.get(`${url}/change-quote?plan=team&seats=18`, t.managerH)).status, 403);
  assert.equal((await app.post(`${url}/changes`, { plan: 'team', seats: 18 }, withKey(t.managerH))).status, 403);
  assert.equal((await app.get(`${url}/history`, t.managerH)).status, 403);
  assert.equal((await app.get(`${url}/change-quote?plan=team&seats=18`, u.ownerH)).status, 404, "another team's Owner");
  assert.equal((await app.post(`${url}/changes`, { plan: 'team', seats: 18 }, withKey(u.ownerH))).status, 404);
  assert.equal((await app.get(`${url}/history`, u.ownerH)).status, 404);
  assert.equal((await app.get(`${url}/history`)).status, 401);
  assert.equal((await operationRows(t.teamId)).filter((o) => o.kind === 'change').length, 0, 'nothing was frozen by any refused request');
});

test('seats raised by a change raise the seat limit: a Starter team that moved to Team 9 can take its sixth member', async () => {
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id });
  for (let i = 0; i < 4; i++) await app.addMember(teamId, (await app.seedUser(`M${i}`)).id, 'staff'); // 5 members: Starter is full
  await seedActiveSubscription(db(teamId), teamId, { plan: 'starter', seats: 5 }, { activationDate: '2031-06-01', requestedByUserId: owner.id });
  at('2031-06-19T10:00:00.000Z');
  const h = bearer((await app.signIn(owner.id)).accessToken);
  const invite = () => app.post(`/teams/${teamId}/invitations`, { email: `invitee-${randomUUID()}@example.com`, role: 'staff' }, h);
  assert.equal((await invite()).status, 409, 'Starter is full');
  const c = await app.post(`${billingUrl(teamId)}/changes`, { plan: 'team', seats: 9 }, withKey(h));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const operationId = c.body.operation.id as string;
  const sessionId = (await operationRow(teamId, operationId)).stripe_checkout_session_id as string;
  const quoteCents = (await operationRow(teamId, operationId)).quote_cents as number;
  assert.equal(quoteCents, 1200, 'Team 9 over Starter 5 with 12 days left: 2000 - 800');
  const before = app.enqueued().length;
  await sendWebhook(app.base, checkoutEventBody({ sessionId, teamId, operationId, amountTotal: quoteCents, paymentIntent: pi('seat_limit') }));
  await runStripeJobs(app.raw, app.enqueued().slice(before));
  assert.deepEqual(await subscriptionOf(teamId), { plan: 'team', seats: 9, paid_basis_cents: 5000, version: 2 });
  assert.equal((await invite()).status, 201, 'the sixth seat exists now');
});
