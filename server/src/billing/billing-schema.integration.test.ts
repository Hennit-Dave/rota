import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createTestShards, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { applyQuoteToState, ledgerRowsForActivation, ledgerRowsForChange, rebuildSubscription, type SubscriptionState } from './ledger.js';
import { monthlyCents, type Entitlements } from './plans.js';
import { quoteChange } from './proration.js';

// The billing schema (ADR 0026), on BOTH test shards because the same migrations run on both (data.md). Real constraints, real triggers.
// Ledger rows can never be deleted, so every test uses fresh random team and operation ids; nothing here depends on a clean database.
let shards: Shards;
before(() => {
  shards = createTestShards({ primaryMax: 2 });
});
after(async () => {
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
});

const starter = (seats: number): Entitlements => ({ plan: 'starter', seats });
const team = (seats: number): Entitlements => ({ plan: 'team', seats });
const business = (seats: number): Entitlements => ({ plan: 'business', seats });

async function period(db: PrismaClient, teamId: string, startsOn = '2031-06-01', endsOn = '2031-07-01', days = 30) {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO billing_periods (team_id, starts_on, ends_on, period_days) VALUES (${teamId}::uuid, ${startsOn}::date, ${endsOn}::date, ${days}) RETURNING id`;
  return rows[0]!.id;
}

/** An operation row with valid defaults; `over` replaces any column's value. */
async function operation(db: PrismaClient, teamId: string, periodId: string, over: Record<string, string | number | null> = {}) {
  const v = {
    id: randomUUID(), kind: 'change', base_version: 1, period_id: periodId, activation_date: null, from_plan: 'starter', from_seats: 5, apply_plan: 'team', apply_seats: 9,
    scheduled_plan: null, scheduled_seats: null, period_days: 30, remaining_days: 20, paid_basis_before: 2000, gross: 3333, credit: 1333, quote: 2000, paid_basis_after: 5000,
    currency: 'usd', status: 'open', session: null, intent: null, completed_at: null, review_reason: null, ...over,
  };
  await db.$executeRaw`
    INSERT INTO payment_operations (id, team_id, kind, requested_by_user_id, base_version, period_id, activation_date, from_plan, from_seats, apply_plan, apply_seats,
      scheduled_plan, scheduled_seats, period_days, remaining_days, paid_basis_before_cents, gross_charge_cents, credit_cents, quote_cents, paid_basis_after_cents,
      currency, status, stripe_checkout_session_id, stripe_payment_intent_id, expires_at, completed_at, review_reason)
    VALUES (${v.id}::uuid, ${teamId}::uuid, ${v.kind}::payment_operation_kind, ${randomUUID()}::uuid, ${v.base_version}, ${v.period_id}::uuid, ${v.activation_date}::date,
      ${v.from_plan}::billing_plan, ${v.from_seats}, ${v.apply_plan}::billing_plan, ${v.apply_seats}, ${v.scheduled_plan}::billing_plan, ${v.scheduled_seats},
      ${v.period_days}, ${v.remaining_days}, ${v.paid_basis_before}, ${v.gross}, ${v.credit}, ${v.quote}, ${v.paid_basis_after},
      ${v.currency}, ${v.status}::payment_operation_status, ${v.session}, ${v.intent}, now() + interval '30 minutes', ${v.completed_at}::timestamptz, ${v.review_reason})`;
  return v.id;
}

/** One ledger row, inserted directly so the database's own rules are what is tested. */
function ledgerInsert(db: PrismaClient, teamId: string, row: Partial<{ operationId: string; type: string; sequence: number; amount: number; currency: string; periodId: string | null; plan: string | null; seats: number | null; basis: number | null }>) {
  const r = { operationId: randomUUID(), sequence: 1, currency: 'usd', periodId: null, plan: null, seats: null, basis: null, ...row };
  return db.$executeRaw`
    INSERT INTO ledger_entries (team_id, operation_id, entry_type, sequence, amount_cents, currency, period_id, plan, seats, paid_basis_after_cents)
    VALUES (${teamId}::uuid, ${r.operationId}::uuid, ${r.type}::ledger_entry_type, ${r.sequence}, ${r.amount}, ${r.currency}, ${r.periodId}::uuid, ${r.plan}::billing_plan, ${r.seats}, ${r.basis})`;
}

for (const shard of ['A', 'B'] as const) {
  const db = () => shards[shard].primary;
  const name = (s: string) => `shard ${shard}: ${s}`;

  test(name('no billing column is a float: money is INTEGER cents'), async () => {
    const cols = await db().$queryRaw<Array<{ table_name: string; column_name: string; data_type: string }>>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('billing_periods','subscriptions','payment_operations','payment_requests','ledger_entries','stripe_events')`;
    assert.ok(cols.length > 40, 'the billing tables exist');
    assert.deepEqual(cols.filter((c) => ['real', 'double precision', 'numeric'].includes(c.data_type)), [], 'no float or decimal column in a billing table');
    const money = cols.filter((c) => /_cents$/.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}:${c.data_type}`).sort();
    assert.deepEqual(money, [
      'ledger_entries.amount_cents:integer',
      'ledger_entries.paid_basis_after_cents:integer',
      'payment_operations.credit_cents:integer',
      'payment_operations.gross_charge_cents:integer',
      'payment_operations.paid_basis_after_cents:integer',
      'payment_operations.paid_basis_before_cents:integer',
      'payment_operations.quote_cents:integer',
      'subscriptions.paid_basis_cents:integer',
    ]);
  });

  test(name('the ledger rejects UPDATE, DELETE and TRUNCATE, and the row is unchanged afterwards'), async () => {
    const teamId = randomUUID();
    const periodId = await period(db(), teamId);
    const operationId = randomUUID();
    await ledgerInsert(db(), teamId, { operationId, type: 'charge', amount: 2000, periodId });
    await assert.rejects(db().$executeRaw`UPDATE ledger_entries SET amount_cents = 1 WHERE operation_id = ${operationId}::uuid`, /ledger_entries is append-only: UPDATE/);
    await assert.rejects(db().$executeRaw`DELETE FROM ledger_entries WHERE operation_id = ${operationId}::uuid`, /ledger_entries is append-only: DELETE/);
    await assert.rejects(db().$executeRaw`TRUNCATE ledger_entries`, /ledger_entries is append-only: TRUNCATE/);
    // Prisma's own methods hit the same trigger.
    await assert.rejects(db().ledgerEntry.deleteMany({ where: { operationId } }), /append-only/);
    await assert.rejects(db().ledgerEntry.updateMany({ where: { operationId }, data: { amountCents: 5 } }), /append-only/);
    const rows = await db().$queryRaw<Array<{ amount_cents: number }>>`SELECT amount_cents FROM ledger_entries WHERE operation_id = ${operationId}::uuid`;
    assert.deepEqual(rows, [{ amount_cents: 2000 }]);
  });

  test(name('a correction is a new row, and the old one stays'), async () => {
    const teamId = randomUUID();
    const periodId = await period(db(), teamId);
    const operationId = randomUUID();
    await ledgerInsert(db(), teamId, { operationId, type: 'charge', amount: 2000, periodId });
    await ledgerInsert(db(), teamId, { operationId, type: 'correction', amount: -500, periodId });
    const rows = await db().ledgerEntry.findMany({ where: { teamId }, orderBy: { position: 'asc' } });
    assert.deepEqual(rows.map((r) => [r.entryType, r.amountCents]), [['charge', 2000], ['correction', -500]]);
    assert.ok(rows[0]!.position < rows[1]!.position, 'position records the write order');
  });

  test(name('the same (operation, type, sequence) cannot be written twice: a replayed payment writes nothing new'), async () => {
    const teamId = randomUUID();
    const periodId = await period(db(), teamId);
    const operationId = randomUUID();
    await ledgerInsert(db(), teamId, { operationId, type: 'charge', amount: 3333, periodId });
    await assert.rejects(ledgerInsert(db(), teamId, { operationId, type: 'charge', amount: 3333, periodId }), /ledger_entries_operation_id_entry_type_sequence_key/);
    await ledgerInsert(db(), teamId, { operationId, type: 'charge', amount: 100, sequence: 2, periodId });
    await ledgerInsert(db(), teamId, { operationId, type: 'credit', amount: -1333, periodId });
    assert.equal(await db().ledgerEntry.count({ where: { operationId } }), 3);
  });

  test(name('ledger rules in the database: signs, state shape, currency, Starter seats, period start'), async () => {
    const teamId = randomUUID();
    const periodId = await period(db(), teamId);
    const bad = (row: Parameters<typeof ledgerInsert>[2], constraint: RegExp) => assert.rejects(ledgerInsert(db(), teamId, { periodId, ...row }), constraint);
    await bad({ type: 'charge', amount: -100 }, /ledger_entries_amount_sign/);
    await bad({ type: 'charge', amount: 0 }, /ledger_entries_amount_sign/);
    await bad({ type: 'credit', amount: 100 }, /ledger_entries_amount_sign/);
    await bad({ type: 'refund', amount: 100 }, /ledger_entries_amount_sign/);
    await bad({ type: 'correction', amount: 0 }, /ledger_entries_amount_sign/);
    await bad({ type: 'entitlement_change', amount: 5, plan: 'team', seats: 9, basis: 5000 }, /ledger_entries_amount_sign/);
    await bad({ type: 'entitlement_change', amount: 0, plan: 'team', seats: null, basis: 5000 }, /ledger_entries_state_shape/);
    await bad({ type: 'entitlement_change', amount: 0, plan: 'team', seats: 0, basis: 5000 }, /ledger_entries_state_shape/);
    await bad({ type: 'entitlement_change', amount: 0, plan: 'starter', seats: 6, basis: 2000 }, /ledger_entries_state_shape/);
    await bad({ type: 'charge', amount: 100, plan: 'team', seats: 9, basis: 5000 }, /ledger_entries_state_shape/);
    await bad({ type: 'charge', amount: 100, currency: 'eur' }, /ledger_entries_currency/);
    await bad({ type: 'charge', amount: 100, sequence: 0 }, /ledger_entries_sequence_positive/);
    await assert.rejects(ledgerInsert(db(), teamId, { type: 'period_start', amount: 0, plan: 'starter', seats: 5, basis: 2000, periodId: null }), /ledger_entries_period_start_has_period/);
    assert.equal(await db().ledgerEntry.count({ where: { teamId } }), 0, 'nothing was written');
    await ledgerInsert(db(), teamId, { type: 'period_start', amount: 0, plan: 'starter', seats: 5, basis: 2000, periodId });
    assert.equal(await db().ledgerEntry.count({ where: { teamId } }), 1);
  });

  test(name('billing periods: 28 to 31 days, the dates must agree with the length, one per start'), async () => {
    const teamId = randomUUID();
    await assert.rejects(period(db(), teamId, '2031-06-01', '2031-07-01', 29), /billing_periods_length/);
    await assert.rejects(period(db(), teamId, '2031-02-01', '2031-03-01', 27), /billing_periods_length/);
    await assert.rejects(period(db(), teamId, '2031-06-01', '2031-08-01', 61), /billing_periods_length/);
    await period(db(), teamId, '2031-02-01', '2031-03-01', 28);
    await assert.rejects(period(db(), teamId, '2031-02-01', '2031-03-01', 28), /billing_periods_team_id_starts_on_key/);
    await period(db(), teamId, '2031-03-01', '2031-04-01', 31);
  });

  test(name('subscriptions: one per team, Starter at most 5 seats, anchor day 1 to 31'), async () => {
    const teamId = randomUUID();
    const periodId = await period(db(), teamId);
    const insert = (plan: string, seats: number, anchor: number, id = teamId) => db().$executeRaw`
      INSERT INTO subscriptions (team_id, plan, seats, billing_anchor_day, paid_basis_cents, version, current_period_id, activated_at)
      VALUES (${id}::uuid, ${plan}::billing_plan, ${seats}, ${anchor}, 2000, 1, ${periodId}::uuid, now())`;
    await assert.rejects(insert('starter', 6, 1), /subscriptions_starter_seats/);
    await assert.rejects(insert('team', 0, 1), /subscriptions_seats_positive/);
    await assert.rejects(insert('starter', 5, 32), /subscriptions_anchor_day/);
    await assert.rejects(insert('starter', 5, 0), /subscriptions_anchor_day/);
    await insert('starter', 5, 31);
    await assert.rejects(insert('team', 9, 31), /subscriptions_pkey/, 'a team has one subscription');
    await insert('team', 60, 15, randomUUID());
  });

  test(name('one open paid operation per team; a closed one frees the place; other teams are unaffected'), async () => {
    const teamId = randomUUID();
    const periodId = await period(db(), teamId);
    const first = await operation(db(), teamId, periodId);
    await assert.rejects(operation(db(), teamId, periodId), /payment_operations_one_open_per_team/);
    const otherTeam = randomUUID();
    await operation(db(), otherTeam, await period(db(), otherTeam));
    await db().$executeRaw`UPDATE payment_operations SET status = 'expired' WHERE id = ${first}::uuid`;
    await operation(db(), teamId, periodId);
    assert.equal(await db().paymentOperation.count({ where: { teamId } }), 2);
  });

  test(name('a payment operation freezes consistent amounts, valid seats and the right shape'), async () => {
    const teamId = randomUUID();
    const periodId = await period(db(), teamId);
    const bad = (over: Record<string, string | number | null>, constraint: RegExp) => assert.rejects(operation(db(), teamId, periodId, over), constraint);
    await bad({ quote: 2001 }, /payment_operations_amounts/);
    await bad({ quote: 0, gross: 1333, credit: 1333 }, /payment_operations_amounts/);
    await bad({ currency: 'eur' }, /payment_operations_currency/);
    await bad({ apply_plan: 'starter', apply_seats: 6 }, /payment_operations_seats/);
    await bad({ remaining_days: 31 }, /payment_operations_period_days/);
    await bad({ period_days: 27, remaining_days: 5 }, /payment_operations_period_days/);
    await bad({ scheduled_plan: 'team', scheduled_seats: null }, /payment_operations_scheduled_pair/);
    await bad({ kind: 'activation', base_version: 1 }, /payment_operations_kind_shape/);
    await bad({ kind: 'change', base_version: 0 }, /payment_operations_kind_shape/);
    await bad({ period_id: null }, /payment_operations_kind_shape/);
    await bad({ status: 'completed' }, /payment_operations_completed_has_payment/);
    await bad({ status: 'needs_review' }, /payment_operations_review_has_reason/);
    // An activation: no period yet, from nothing, the first period is paid in full.
    await operation(db(), teamId, periodId, { kind: 'activation', base_version: 0, period_id: null, activation_date: '2031-06-01', from_plan: null, from_seats: null, apply_plan: 'starter', apply_seats: 5, paid_basis_before: 0, gross: 2000, credit: 0, quote: 2000, paid_basis_after: 2000, remaining_days: 30 });
    assert.equal(await db().paymentOperation.count({ where: { teamId } }), 1);
  });

  test(name('a payment ID belongs to one operation (unique across operations); so does a Checkout session'), async () => {
    const intent = `pi_test_${randomUUID()}`;
    const session = `cs_test_${randomUUID()}`;
    const t1 = randomUUID();
    const t2 = randomUUID();
    const p1 = await period(db(), t1);
    const p2 = await period(db(), t2);
    await operation(db(), t1, p1, { status: 'completed', intent, completed_at: '2031-06-11T10:00:00Z', session });
    await assert.rejects(operation(db(), t2, p2, { status: 'completed', intent, completed_at: '2031-06-11T10:00:00Z' }), /payment_operations_stripe_payment_intent_id_key/);
    await assert.rejects(operation(db(), t2, p2, { session }), /payment_operations_stripe_checkout_session_id_key/);
  });

  test(name('an Idempotency-Key is unique per team; the same key on another team is fine'), async () => {
    const key = randomUUID();
    const t1 = randomUUID();
    const insert = (teamId: string) => db().paymentRequest.create({ data: { teamId, userId: randomUUID(), idempotencyKey: key, requestFingerprint: 'abc', responseStatus: 201, response: { ok: true } } });
    await insert(t1);
    await assert.rejects(insert(t1), /payment_requests_team_id_idempotency_key_key/);
    await insert(randomUUID());
  });

  test(name('the webhook inbox: one row per Stripe event id, processed only with an outcome'), async () => {
    const eventId = `evt_test_${randomUUID()}`;
    const insert = (id: string, extra = {}) => db().stripeEvent.create({ data: { eventId: id, eventType: 'checkout.session.completed', livemode: false, stripeCreatedAt: new Date(), ...extra } });
    await insert(eventId);
    await assert.rejects(insert(eventId), /stripe_events_pkey|Unique constraint/, 'a replayed event is refused by the database');
    await assert.rejects(insert(`evt_test_${randomUUID()}`, { processedAt: new Date() }), /stripe_events_processed_has_outcome/);
    await assert.rejects(insert(`evt_test_${randomUUID()}`, { outcome: 'applied' }), /stripe_events_processed_has_outcome/);
    await assert.rejects(insert(`evt_test_${randomUUID()}`, { processedAt: new Date(), outcome: 'weird' }), /stripe_events_outcome_known/);
    await db().stripeEvent.update({ where: { eventId }, data: { processedAt: new Date(), outcome: 'applied' } });
    await db().stripeEvent.deleteMany({ where: { eventId: { startsWith: 'evt_test_' }, processedAt: { not: null } } });
  });

  test(name('rebuilding the subscription from the ledger in the database matches the stored subscription (the brief, then test 7, then a cheaper upgrade)'), async () => {
    const scenarios: Array<[Entitlements, Array<{ to: Entitlements; remaining: number }>]> = [
      [starter(5), [{ to: team(9), remaining: 20 }]],
      [starter(5), [{ to: team(9), remaining: 20 }, { to: business(9), remaining: 10 }]],
      [team(50), [{ to: business(50), remaining: 10 }, { to: business(55), remaining: 10 }, { to: business(60), remaining: 10 }]],
      [team(18), [{ to: business(10), remaining: 20 }, { to: business(10), remaining: 5 }]],
    ];
    for (const [first, steps] of scenarios) {
      const teamId = randomUUID();
      const periodId = await period(db(), teamId);
      let state: SubscriptionState = { plan: first.plan, seats: first.seats, paidBasisCents: monthlyCents(first), currentPeriodId: periodId, version: 1 };
      // The way a transaction would: every operation's rows and the subscription update commit together.
      await db().$transaction(async (tx) => {
        await tx.ledgerEntry.createMany({ data: ledgerRowsForActivation({ operationId: randomUUID(), periodId, entitlements: first }).map((r) => ({ teamId, ...r, entryType: r.entryType, paidBasisAfterCents: r.paidBasisAfterCents })) });
        await tx.subscription.create({ data: { teamId, plan: state.plan, seats: state.seats, billingAnchorDay: 1, paidBasisCents: state.paidBasisCents, version: 1, currentPeriodId: periodId, activatedAt: new Date() } });
      });
      for (const step of steps) {
        const quote = quoteChange({ current: { plan: state.plan, seats: state.seats }, target: step.to, paidBasisCents: state.paidBasisCents, periodDays: 30, remainingDays: step.remaining });
        const rows = ledgerRowsForChange({ operationId: randomUUID(), periodId, quote });
        const next = applyQuoteToState(state, quote);
        await db().$transaction(async (tx) => {
          if (rows.length > 0) await tx.ledgerEntry.createMany({ data: rows.map((r) => ({ teamId, ...r })) });
          await tx.subscription.update({ where: { teamId }, data: { plan: next.plan, seats: next.seats, paidBasisCents: next.paidBasisCents, version: next.version } });
        });
        state = next;
      }
      const stored = await db().subscription.findUniqueOrThrow({ where: { teamId } });
      const ledger = await db().ledgerEntry.findMany({ where: { teamId }, orderBy: { position: 'asc' } });
      const rebuilt = rebuildSubscription(
        ledger.map((r) => ({ operationId: r.operationId, entryType: r.entryType, sequence: r.sequence, amountCents: r.amountCents, periodId: r.periodId, plan: r.plan, seats: r.seats, paidBasisAfterCents: r.paidBasisAfterCents })),
      );
      assert.deepEqual(rebuilt, { plan: stored.plan, seats: stored.seats, paidBasisCents: stored.paidBasisCents, currentPeriodId: stored.currentPeriodId, version: stored.version });
    }
  });
}
