import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor, type ShardId } from '../db/shard.js';
import { createEmailHandler } from '../jobs/email.js';
import type { ResendClient } from '../jobs/resend.js';
import { createWorkProcessor } from '../jobs/worker.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { rebuildSubscription, type LedgerRow } from './ledger.js';
import { periodAfter } from './periods.js';
import { createRenewalHandler, ensureRenewals, RENEWAL_KIND, type RenewalDeps } from './renewal.js';
import { FakeStripe, intentEventBody, sendWebhook, checkoutEventBody, signedHeaders, type IntentEventOptions } from './stripe.testkit.js';
import { createStripeEventHandler } from './stripeEventJob.js';
import { seedActiveSubscription } from './testkit.js';

// Renewals and failed renewals (ADR 0031): the real routes, the real webhook route, the real renewal job and event job through the real work processor, the TEST shards.
// Only Stripe is a fake (FakeStripe), and its events are signed with Stripe's own test-header generator. Ledger rows can never be deleted (ADR 0026), so every test uses fresh
// teams. "Now" is the real clock: a renewal is due when its period ended at 00:00 UTC today; the grace period is moved in the database where a test needs time to pass.
const RUN = randomUUID().slice(0, 8);
const pi = (name: string) => `pi_test_${name}_${RUN}`;
const sender = { from: 'Rota <notification@rota.davebuilds.design>', replyTo: 'rota@davebuilds.design' };
const GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

let app: TeamsTestApp;
let stripe: FakeStripe;
/** What the WORKER asked to have enqueued (the next renewal, the Owner's emails): the API's own spy is `app.enqueued()`. */
let workerQueued: Array<{ rowId: string; shard: ShardId }>;

before(async () => {
  stripe = new FakeStripe();
  workerQueued = [];
  app = await startTeamsTestApp({
    billing: { stripe },
    invites: { globalDailyCap: 1000, linkMaxPending: 50 },
    rateLimits: {
      inviteSendUser: { max: 1000, windowSeconds: 60 },
      inviteSendTeam: { max: 1000, windowSeconds: 60 },
      inviteLinkUser: { max: 1000, windowSeconds: 60 },
      inviteLinkTeam: { max: 1000, windowSeconds: 60 },
      swapRequestUser: { max: 1000, windowSeconds: 60 },
    },
  });
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const billingUrl = (teamId: string) => `/teams/${teamId}/billing`;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

function renewalDeps(over: Partial<RenewalDeps> = {}): RenewalDeps {
  return { shards: app.raw, stripe, graceDays: GRACE_DAYS, sender, enqueue: async (_p, row, shard) => void workerQueued.push({ rowId: row.id, shard }), ...over };
}
function handlers(over: Partial<RenewalDeps> = {}) {
  const d = renewalDeps(over);
  return {
    [RENEWAL_KIND]: createRenewalHandler(d),
    stripe_event: createStripeEventHandler({ shards: app.raw, stripe: d.stripe, renewal: { graceDays: d.graceDays, sender: d.sender, enqueue: d.enqueue } }),
  };
}
/** Runs the REAL job processor (claim, handler, completion) for each row, as the worker would. */
async function run(rows: Array<{ rowId: string; shard: ShardId }>, over: Partial<RenewalDeps> = {}) {
  const processor = createWorkProcessor(app.raw, handlers(over));
  for (const row of rows) await processor({ id: `job-${row.rowId}-1`, data: { rowId: row.rowId, generation: 1, shard: row.shard } } as never, undefined);
}
const workStatus = async (teamId: string, rowId: string) =>
  (await db(teamId).$queryRaw<Array<{ status: string; failure_reason: string | null; execution_attempts: number }>>`SELECT status::text AS status, failure_reason, execution_attempts FROM work_rows WHERE id = ${rowId}::uuid`)[0]!;

interface Ctx {
  teamId: string;
  shard: ShardId;
  owner: { id: string; email: string };
  ownerH: Record<string, string>;
  manager: { id: string };
  managerH: Record<string, string>;
  staff: { id: string; name: string }[];
  periodId: string;
  renewalId: string;
  workRow: { rowId: string; shard: ShardId };
  endsOn: string;
  anchorDay: number;
}

/** A team whose period ENDED at 00:00 UTC today, so its renewal is due now. By default it has a saved card. */
async function setup(opts: { shard?: ShardId; card?: boolean; plan?: 'starter' | 'team' | 'business'; seats?: number; staff?: number } = {}): Promise<Ctx> {
  const owner = await app.seedUser('Olive Owner');
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  const staff: Ctx['staff'] = [];
  for (let i = 0; i < (opts.staff ?? 0); i++) {
    const name = `Sam Staff ${i}`;
    const u = await app.seedUser(name);
    await app.addMember(teamId, u.id, 'staff');
    staff.push({ id: u.id, name });
  }
  const startsOn = daysAgo(30);
  const endsOn = today();
  const seeded = await seedActiveSubscription(db(teamId), teamId, { plan: opts.plan ?? 'team', seats: opts.seats ?? 9 }, {
    activationDate: startsOn,
    requestedByUserId: owner.id,
    period: { startsOn, endsOn, periodDays: 30 },
    renewal: true,
  });
  if (opts.card !== false) await addCard(teamId);
  return {
    teamId,
    shard,
    owner,
    ownerH: bearer((await app.signIn(owner.id)).accessToken),
    manager,
    managerH: bearer((await app.signIn(manager.id)).accessToken),
    staff,
    periodId: seeded.periodId,
    renewalId: seeded.renewalId!,
    workRow: { rowId: seeded.renewalWork!.id, shard },
    endsOn,
    anchorDay: Number(startsOn.slice(8, 10)),
  };
}

let cardNo = 0;
/** A saved card exactly as P6a records one (its tests prove the recording); here it is only the thing a renewal charges. */
async function addCard(teamId: string, over: { customer?: string; paymentMethod?: string } = {}): Promise<{ customer: string; paymentMethod: string }> {
  const customer = over.customer ?? `cus_test_${RUN}_${teamId.slice(0, 8)}`;
  const paymentMethod = over.paymentMethod ?? `pm_test_${RUN}_${++cardNo}_${teamId.slice(0, 8)}`;
  await db(teamId).$executeRaw`UPDATE team_payment_methods SET status = 'replaced'::saved_card_status, replaced_at = NOW() WHERE team_id = ${teamId}::uuid AND status = 'active'::saved_card_status`;
  await db(teamId).$executeRaw`
    INSERT INTO team_payment_methods (team_id, stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, source, source_id,
      consent_wording, consent_amount_cents, consent_anchor_day, consented_at)
    VALUES (${teamId}::uuid, ${customer}, ${paymentMethod}, 'visa', '4242', 12, 2034, 'card_setup'::saved_card_source, ${randomUUID()}::uuid, 'By saving this card, you authorise Rota to charge it. Test mode only.', 5000, 1, NOW())`;
  return { customer, paymentMethod };
}

const renewalOf = async (teamId: string, renewalId: string) =>
  (await db(teamId).$queryRaw<Array<Record<string, any>>>`
    SELECT status::text AS status, amount_cents, base_version, result_plan::text AS result_plan, result_seats, scheduled_change_id::text AS scheduled_change_id, attempt_count,
      stripe_payment_intent_id, failure_code, failed_at, grace_ends_at, paid_at, next_period_id::text AS next_period_id, review_reason, due_at
    FROM renewals WHERE id = ${renewalId}::uuid`)[0]!;
const subscriptionOf = async (teamId: string) =>
  (await db(teamId).$queryRaw<Array<Record<string, any>>>`SELECT plan::text AS plan, seats, paid_basis_cents, version, current_period_id::text AS current_period_id FROM subscriptions WHERE team_id = ${teamId}::uuid`)[0]!;
const ledgerOf = (teamId: string) =>
  db(teamId).$queryRaw<Array<{ entry_type: string; sequence: number; amount_cents: number; plan: string | null; seats: number | null; paid_basis_after_cents: number | null; stripe_payment_intent_id: string | null; operation_id: string; period_id: string | null }>>`
    SELECT entry_type::text AS entry_type, sequence, amount_cents, plan::text AS plan, seats, paid_basis_after_cents, stripe_payment_intent_id, operation_id::text AS operation_id, period_id::text AS period_id
    FROM ledger_entries WHERE team_id = ${teamId}::uuid ORDER BY position`;
const renewalsOf = (teamId: string) =>
  db(teamId).$queryRaw<Array<{ id: string; period_id: string; status: string; due_at: Date }>>`SELECT id::text AS id, period_id::text AS period_id, status::text AS status, due_at FROM renewals WHERE team_id = ${teamId}::uuid ORDER BY due_at`;
const emailsOf = (teamId: string, renewalId: string) =>
  db(teamId).$queryRaw<Array<{ id: string; run_at: Date; status: string; payload: Record<string, any> }>>`
    SELECT id::text AS id, run_at, status::text AS status, payload FROM work_rows WHERE kind = 'email' AND payload->>'renewalId' = ${renewalId} ORDER BY run_at`;
const eventRow = async (eventId: string) =>
  (await app.raw.A.primary.$queryRaw<Array<{ outcome: string | null; processed: boolean; team_id: string | null; operation_id: string | null }>>`
    SELECT outcome, processed_at IS NOT NULL AS processed, team_id::text AS team_id, operation_id::text AS operation_id FROM stripe_events WHERE event_id = ${eventId}`)[0];
const asLedgerRows = (rows: Awaited<ReturnType<typeof ledgerOf>>): LedgerRow[] =>
  rows.map((r) => ({ operationId: r.operation_id, entryType: r.entry_type as LedgerRow['entryType'], sequence: r.sequence, amountCents: r.amount_cents, periodId: r.period_id, plan: r.plan as LedgerRow['plan'], seats: r.seats, paidBasisAfterCents: r.paid_basis_after_cents }));

/** Sends a signed PaymentIntent event for a renewal and runs the jobs it queued, like the API and the worker would. */
async function deliver(t: Ctx, o: Partial<IntentEventOptions> & { paymentIntentId: string }, over: Partial<RenewalDeps> = {}) {
  const before = app.enqueued().length;
  const payload = intentEventBody({ teamId: t.teamId, renewalId: t.renewalId, attempt: 1, ...o });
  const res = await sendWebhook(app.base, payload);
  const queued = app.enqueued().slice(before);
  await run(queued, over);
  return { res, payload, eventId: JSON.parse(payload).id as string, queued };
}

/** Charges the due renewal (attempt 1) and returns the PaymentIntent the fake Stripe made. */
async function charge(t: Ctx) {
  const calls = stripe.renewalCalls.length;
  await run([t.workRow]);
  const made = stripe.renewalCalls.slice(calls);
  return { made, paymentIntentId: made.length > 0 ? stripe.renewalIntents.get(made.at(-1)!.key)! : null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- success

for (const shard of ['A', 'B'] as const) {
  test(`RENEWAL on shard ${shard}: the job charges the saved card once; ONLY the verified webhook applies it: next period, ledger rows, subscription, the next renewal; the ledger rebuilds the subscription`, async () => {
    const t = await setup({ shard });
    const before = await subscriptionOf(t.teamId);
    const ledgerBefore = await ledgerOf(t.teamId);
    const card = (await db(t.teamId).$queryRaw<Array<{ c: string; p: string }>>`SELECT stripe_customer_id AS c, stripe_payment_method_id AS p FROM team_payment_methods WHERE team_id = ${t.teamId}::uuid AND status = 'active'::saved_card_status`)[0]!;

    const { made, paymentIntentId } = await charge(t);
    // One Stripe call: the amount OUR engine calculated (Team, 9 seats), the saved card, a key that is stable per attempt.
    assert.equal(made.length, 1);
    assert.equal(made[0]!.key, `renewal-${t.renewalId}-1`);
    assert.deepEqual(
      { amountCents: made[0]!.request.amountCents, customerId: made[0]!.request.customerId, paymentMethodId: made[0]!.request.paymentMethodId, teamId: made[0]!.request.teamId, attempt: made[0]!.request.attempt },
      { amountCents: 5000, customerId: card.c, paymentMethodId: card.p, teamId: t.teamId, attempt: 1 },
    );
    // The job decided NOTHING: the attempt is frozen and waiting; the subscription and the ledger are exactly as before.
    const charging = await renewalOf(t.teamId, t.renewalId);
    assert.deepEqual(
      { status: charging.status, amount: charging.amount_cents, attempts: charging.attempt_count, plan: charging.result_plan, seats: charging.result_seats, base: charging.base_version, pi: charging.stripe_payment_intent_id },
      { status: 'charging', amount: 5000, attempts: 1, plan: 'team', seats: 9, base: before.version, pi: paymentIntentId },
    );
    assert.deepEqual(await subscriptionOf(t.teamId), before);
    assert.deepEqual(await ledgerOf(t.teamId), ledgerBefore);
    assert.equal((await workStatus(t.teamId, t.workRow.rowId)).status, 'done');

    // The verified webhook decides.
    const delivered = await deliver(t, { paymentIntentId: paymentIntentId!, amount: 5000 });
    assert.equal(delivered.res.status, 200);
    assert.deepEqual(await eventRow(delivered.eventId), { outcome: 'applied', processed: true, team_id: t.teamId, operation_id: t.renewalId });

    const next = periodAfter(t.endsOn, t.anchorDay);
    const sub = await subscriptionOf(t.teamId);
    assert.deepEqual({ plan: sub.plan, seats: sub.seats, paid: sub.paid_basis_cents, version: sub.version }, { plan: 'team', seats: 9, paid: 5000, version: before.version + 1 });
    const newPeriod = (await db(t.teamId).$queryRaw<Array<{ id: string; starts_on: string; ends_on: string; period_days: number }>>`
      SELECT id::text AS id, starts_on::text AS starts_on, ends_on::text AS ends_on, period_days FROM billing_periods WHERE id = ${sub.current_period_id}::uuid`)[0]!;
    assert.deepEqual({ startsOn: newPeriod.starts_on, endsOn: newPeriod.ends_on, periodDays: newPeriod.period_days }, next);

    const ledger = await ledgerOf(t.teamId);
    assert.deepEqual(
      ledger.slice(ledgerBefore.length).map((r) => [r.entry_type, r.sequence, r.amount_cents, r.plan, r.seats, r.paid_basis_after_cents, r.stripe_payment_intent_id, r.operation_id, r.period_id]),
      [
        ['period_start', 1, 0, 'team', 9, 5000, null, t.renewalId, newPeriod.id],
        ['charge', 1, 5000, null, null, null, paymentIntentId, t.renewalId, newPeriod.id],
      ],
    );
    const rebuilt = rebuildSubscription(asLedgerRows(ledger));
    assert.deepEqual({ plan: rebuilt.plan, seats: rebuilt.seats, paidBasisCents: rebuilt.paidBasisCents, version: rebuilt.version, currentPeriodId: rebuilt.currentPeriodId }, { plan: sub.plan, seats: sub.seats, paidBasisCents: sub.paid_basis_cents, version: sub.version, currentPeriodId: sub.current_period_id });

    const paid = await renewalOf(t.teamId, t.renewalId);
    assert.deepEqual({ status: paid.status, pi: paid.stripe_payment_intent_id, nextPeriod: paid.next_period_id }, { status: 'paid', pi: paymentIntentId, nextPeriod: newPeriod.id });
    // The NEXT renewal is already scheduled for the new period's end, with its own work row.
    const renewals = await renewalsOf(t.teamId);
    assert.equal(renewals.length, 2);
    const upcoming = renewals.find((r) => r.period_id === newPeriod.id)!;
    assert.equal(upcoming.status, 'scheduled');
    assert.equal(upcoming.due_at.toISOString(), `${next.endsOn}T00:00:00.000Z`);
    const upcomingWork = await db(t.teamId).$queryRaw<Array<{ run_at: Date; status: string }>>`SELECT run_at, status::text AS status FROM work_rows WHERE kind = 'renewal' AND payload->>'renewalId' = ${upcoming.id}`;
    assert.equal(upcomingWork.length, 1);
    assert.equal(upcomingWork[0]!.run_at.toISOString(), `${next.endsOn}T00:00:00.000Z`);
    assert.ok(workerQueued.some((q) => q.shard === shard), 'the next renewal was handed to the queue');

    // The same event again (Stripe redelivers), and a second event for the same payment: nothing more is written.
    const again = await sendWebhook(app.base, delivered.payload);
    assert.equal(again.status, 200);
    const second = await deliver(t, { paymentIntentId: paymentIntentId!, amount: 5000 });
    assert.equal(second.res.status, 200);
    assert.deepEqual(await eventRow(second.eventId), { outcome: 'duplicate', processed: true, team_id: t.teamId, operation_id: t.renewalId });
    assert.equal((await ledgerOf(t.teamId)).length, ledger.length);
    assert.equal((await subscriptionOf(t.teamId)).version, before.version + 1);
    assert.equal((await renewalsOf(t.teamId)).length, 2);
  });
}

test('the renewal job runs twice (a replay, a retry after a crash): the card is charged ONCE and nothing else changes', async () => {
  const t = await setup();
  await run([t.workRow]);
  assert.equal(stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId).length, 1);
  // A second execution of the same work (the claim is released as if the first crashed after the Stripe call): the attempt is frozen and has its PaymentIntent.
  await db(t.teamId).$executeRaw`UPDATE work_rows SET status = 'pending'::work_status, claim_token = NULL, claim_expires_at = NULL WHERE id = ${t.workRow.rowId}::uuid`;
  await run([t.workRow]);
  assert.equal(stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId).length, 1, 'no second charge');
  assert.equal((await renewalOf(t.teamId, t.renewalId)).attempt_count, 1);
});

test('an UNCERTAIN Stripe answer is retried with the SAME key and finds the payment it already made: one PaymentIntent, never two', async () => {
  const t = await setup();
  stripe.renewalScript.push('uncertain_after_create');
  await run([t.workRow]).catch(() => undefined); // the processor releases the claim and rethrows for BullMQ's retry
  const after1 = await renewalOf(t.teamId, t.renewalId);
  assert.equal(after1.status, 'charging');
  assert.equal(after1.stripe_payment_intent_id, null, 'the answer was never learned');
  assert.equal((await workStatus(t.teamId, t.workRow.rowId)).status, 'pending');

  await run([t.workRow]); // the retry
  const calls = stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.key, calls[1]!.key, 'the same idempotency key');
  const intentIds = new Set(calls.map((c) => stripe.renewalIntents.get(c.key)));
  assert.equal(intentIds.size, 1, 'Stripe made ONE payment');
  assert.equal((await renewalOf(t.teamId, t.renewalId)).stripe_payment_intent_id, [...intentIds][0]);
});

test('after the attempt budget with the answer still unknown the renewal FAILS for a human (charge_unconfirmed); a payment that did go through is still accepted from its webhook', async () => {
  const t = await setup();
  await db(t.teamId).$executeRaw`UPDATE work_rows SET execution_attempts = 4 WHERE id = ${t.workRow.rowId}::uuid`; // the claim makes it 5, the maximum
  stripe.renewalScript.push('uncertain_before_create');
  await run([t.workRow]);
  const failed = await renewalOf(t.teamId, t.renewalId);
  assert.deepEqual([failed.status, failed.failure_code], ['past_due', 'charge_unconfirmed']);
  assert.equal((await emailsOf(t.teamId, t.renewalId)).length, 2, 'the Owner is told');

  // The payment actually went through on Stripe's side: its verified webhook is accepted for this renewal and amount.
  const delivered = await deliver(t, { paymentIntentId: pi('late_success'), amount: 5000 });
  assert.equal((await eventRow(delivered.eventId))!.outcome, 'applied');
  assert.equal((await renewalOf(t.teamId, t.renewalId)).status, 'paid');
});

test('an attempt left for more than 23 hours is NOT repeated (Stripe may have forgotten its key, so a repeat could charge twice): it fails for a human', async () => {
  const t = await setup();
  stripe.renewalScript.push('uncertain_before_create');
  await run([t.workRow]).catch(() => undefined);
  await db(t.teamId).$executeRaw`UPDATE renewals SET attempt_started_at = NOW() - interval '24 hours' WHERE id = ${t.renewalId}::uuid`;
  const calls = stripe.renewalCalls.length;
  await run([t.workRow]);
  assert.equal(stripe.renewalCalls.length, calls, 'no call to Stripe');
  assert.equal((await renewalOf(t.teamId, t.renewalId)).failure_code, 'charge_unconfirmed');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- failure

test('a DECLINED card: the job charges once, only the verified webhook records the failure; the team is past due with 7 days of grace, still fully writable, and the Owner (only) is emailed twice', async () => {
  const t = await setup({ staff: 1 });
  stripe.renewalScript.push('declined');
  const { paymentIntentId } = await charge(t);
  // Declined, but the job did not record the failure: that waits for the webhook.
  assert.equal((await renewalOf(t.teamId, t.renewalId)).status, 'charging');
  assert.equal((await renewalOf(t.teamId, t.renewalId)).stripe_payment_intent_id, paymentIntentId);

  const sentAt = Date.now();
  const delivered = await deliver(t, { type: 'payment_intent.payment_failed', paymentIntentId: paymentIntentId!, errorCode: 'card_declined' });
  assert.equal((await eventRow(delivered.eventId))!.outcome, 'applied');
  const failed = await renewalOf(t.teamId, t.renewalId);
  assert.deepEqual([failed.status, failed.failure_code], ['past_due', 'card_declined']);
  const graceMs = failed.grace_ends_at.getTime() - failed.failed_at.getTime();
  assert.equal(graceMs, GRACE_DAYS * DAY_MS, 'exactly 7 days of grace');
  assert.ok(Math.abs(failed.failed_at.getTime() - sentAt) < 60_000);

  // Nothing was charged or applied; the old period still stands.
  assert.deepEqual((await ledgerOf(t.teamId)).map((r) => r.entry_type), ['period_start', 'charge']);
  assert.equal((await subscriptionOf(t.teamId)).current_period_id, t.periodId);

  // The Owner's two emails (frozen in the same transaction as the failure): one now, one for the end of the grace period that is skipped if it was paid by then.
  const mails = await emailsOf(t.teamId, t.renewalId);
  assert.equal(mails.length, 2);
  for (const m of mails) {
    assert.deepEqual(m.payload.to, [t.owner.email], 'the Owner alone');
    assert.equal(m.payload.from, sender.from);
    assert.equal(m.payload.replyTo, sender.replyTo);
  }
  assert.match(mails[0]!.payload.subject, /could not collect/);
  assert.equal(mails[0]!.payload.skipIfRenewalPaid, undefined);
  assert.match(mails[1]!.payload.subject, /now read-only/);
  assert.equal(mails[1]!.payload.skipIfRenewalPaid, true);
  assert.equal(mails[1]!.run_at.getTime(), failed.grace_ends_at.getTime(), 'it runs when the grace period ends');
  assert.ok(workerQueued.some((q) => mails.some((m) => m.id === q.rowId)), 'handed to the queue after the commit');

  // The same failure delivered AGAIN as a new event (stale: the attempt is no longer charging): ignored, and no third email, no longer grace.
  const stale = await deliver(t, { type: 'payment_intent.payment_failed', paymentIntentId: paymentIntentId!, errorCode: 'card_declined' });
  assert.equal((await eventRow(stale.eventId))!.outcome, 'ignored');
  assert.equal((await emailsOf(t.teamId, t.renewalId)).length, 2);
  assert.equal((await renewalOf(t.teamId, t.renewalId)).grace_ends_at.getTime(), failed.grace_ends_at.getTime());

  // Inside the grace period the team keeps FULL access, and everyone can read.
  const shift = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Open', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, t.ownerH);
  assert.equal(shift.status, 201, JSON.stringify(shift.body));
  const team = await app.get(`/teams/${t.teamId}`, t.ownerH);
  assert.equal(team.body.canEditShifts, true);
  assert.equal(team.body.billingNotice.state, 'past_due');
  assert.equal(team.body.billingNotice.readOnly, false);
  const staffTeam = await app.get(`/teams/${t.teamId}`, bearer((await app.signIn(t.staff[0]!.id)).accessToken));
  assert.equal(staffTeam.body.billingNotice, null, 'staff are told nothing until it affects them');
});

test('an authentication-required decline is recorded with its own plain-words reason (the bank wants the customer present, which a saved card cannot give)', async () => {
  const t = await setup();
  stripe.renewalScript.push('declined');
  const { paymentIntentId } = await charge(t);
  await deliver(t, { type: 'payment_intent.payment_failed', paymentIntentId: paymentIntentId!, errorCode: 'authentication_required' });
  assert.equal((await renewalOf(t.teamId, t.renewalId)).failure_code, 'authentication_required');
  const overview = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.equal(overview.body.renewal.state, 'past_due');
  assert.match(overview.body.renewal.detail, /bank wants you to confirm/);
});

test('NO SAVED CARD: nothing is charged, the team follows the failed-renewal path at once, and the Owner is told', async () => {
  const t = await setup({ card: false });
  const { made } = await charge(t);
  assert.equal(made.length, 0, 'no call to Stripe');
  const row = await renewalOf(t.teamId, t.renewalId);
  assert.deepEqual([row.status, row.failure_code], ['past_due', 'no_card']);
  assert.equal(row.grace_ends_at.getTime() - row.failed_at.getTime(), GRACE_DAYS * DAY_MS);
  assert.equal((await emailsOf(t.teamId, t.renewalId)).length, 2);
  assert.match((await app.get(billingUrl(t.teamId), t.ownerH)).body.renewal.detail, /no saved card/);
});

test('Stripe REFUSES the request (no payment exists, so no webhook will come): the failure is recorded by the job itself', async () => {
  const t = await setup();
  stripe.renewalScript.push('rejected');
  await run([t.workRow]);
  assert.deepEqual([(await renewalOf(t.teamId, t.renewalId)).status, (await renewalOf(t.teamId, t.renewalId)).failure_code], ['past_due', 'charge_refused']);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- read-only

/** Moves a failed renewal's grace period into the past, as if the days had gone by. */
async function expireGrace(t: Ctx) {
  await db(t.teamId).$executeRaw`UPDATE renewals SET failed_at = NOW() - interval '8 days', grace_ends_at = NOW() - interval '1 day' WHERE id = ${t.renewalId}::uuid`;
}
/** A team whose renewal failed (declined) and whose grace period has now ended. */
async function setupReadOnly(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup({ staff: 1, ...opts });
  stripe.renewalScript.push('declined');
  const { paymentIntentId } = await charge(t);
  await deliver(t, { type: 'payment_intent.payment_failed', paymentIntentId: paymentIntentId! });
  await expireGrace(t);
  return { t, paymentIntentId: paymentIntentId! };
}

test('READ-ONLY after the grace period: EVERY non-billing write is refused (shifts, swaps, invitations), reads and billing keep working, a stranger still gets a plain 404', async () => {
  const { t } = await setupReadOnly();
  const refused = (res: { status: number; body: any }, label: string) => {
    assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'team_read_only', label);
  };
  const shiftId = randomUUID();
  const swapId = randomUUID();
  const invitationId = randomUUID();
  const key = () => ({ ...t.ownerH, 'idempotency-key': randomUUID() });

  // shifts (create, update, delete)
  refused(await app.post(`/teams/${t.teamId}/shifts`, { title: 'Late', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, t.ownerH), 'create shift');
  refused(await app.patch(`/teams/${t.teamId}/shifts/${shiftId}`, { title: 'Changed' }, t.ownerH), 'update shift');
  refused(await app.del(`/teams/${t.teamId}/shifts/${shiftId}`, t.ownerH), 'delete shift');
  // swaps (request, cancel, approve, reject)
  refused(await app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: randomUUID(), requestedShiftId: randomUUID() }, key()), 'request swap');
  refused(await app.post(`/teams/${t.teamId}/swaps/${swapId}/cancel`, {}, t.ownerH), 'cancel swap');
  refused(await app.post(`/teams/${t.teamId}/swaps/${swapId}/approve`, {}, t.ownerH), 'approve swap');
  refused(await app.post(`/teams/${t.teamId}/swaps/${swapId}/reject`, {}, t.ownerH), 'reject swap');
  // invitations (email invite, invite link, resend, revoke)
  refused(await app.post(`/teams/${t.teamId}/invitations`, { email: `new-${RUN}@example.test`, role: 'staff' }, t.ownerH), 'invite');
  refused(await app.post(`/teams/${t.teamId}/invitations/links`, {}, t.ownerH), 'invite link');
  refused(await app.post(`/teams/${t.teamId}/invitations/${invitationId}/resend`, {}, t.ownerH), 'resend invitation');
  refused(await app.del(`/teams/${t.teamId}/invitations/${invitationId}`, t.ownerH), 'revoke invitation');
  // a Manager and a member are refused the same way
  refused(await app.post(`/teams/${t.teamId}/shifts`, { title: 'Late', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, t.managerH), 'manager create shift');

  // nothing was written by any of them
  assert.equal(Number((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM shifts WHERE team_id = ${t.teamId}::uuid`)[0]!.n), 0);
  assert.equal(Number((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM invitations WHERE team_id = ${t.teamId}::uuid`)[0]!.n), 0);

  // reads keep working, for everyone
  assert.equal((await app.get(`/teams/${t.teamId}/shifts?from=2031-06-01T00:00:00.000Z&to=2031-06-30T00:00:00.000Z`, t.managerH)).status, 200);
  assert.equal((await app.get(`/teams/${t.teamId}/swaps`, t.managerH)).status, 200);
  assert.equal((await app.get(`/teams/${t.teamId}/invitations`, t.ownerH)).status, 200);
  assert.equal((await app.get(`/teams/${t.teamId}/members`, t.managerH)).status, 200);
  const ownerTeam = await app.get(`/teams/${t.teamId}`, t.ownerH);
  assert.equal(ownerTeam.status, 200);
  assert.equal(ownerTeam.body.canEditShifts, false, 'the server says the screens must not offer editing');
  assert.equal(ownerTeam.body.billingNotice.state, 'read_only');
  assert.equal(ownerTeam.body.billingNotice.readOnly, true);
  // a member who is not the Owner sees that the team is read-only, without the Owner's payment details
  const staffH = bearer((await app.signIn(t.staff[0]!.id)).accessToken);
  const staffTeam = await app.get(`/teams/${t.teamId}`, staffH);
  assert.equal(staffTeam.body.billingNotice.state, 'read_only');
  assert.doesNotMatch(JSON.stringify(staffTeam.body.billingNotice), /card|\$/i);
  assert.equal(staffTeam.body.canEditShifts, false);
  // sign-in (a new session) still works
  assert.ok((await app.signIn(t.owner.id)).accessToken);

  // billing keeps working for the Owner: the overview, history, a quote, the saved card, the retry
  const overview = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.renewal.state, 'read_only');
  assert.equal(overview.body.renewal.readOnly, true);
  assert.equal(overview.body.renewal.canRetry, true);
  assert.equal((await app.get(`${billingUrl(t.teamId)}/history`, t.ownerH)).status, 200);
  const setup = await app.post(`${billingUrl(t.teamId)}/card/setup`, {}, key());
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const retry = await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.ownerH);
  assert.equal(retry.status, 202, JSON.stringify(retry.body));

  // A stranger gets exactly the 404 they would get for a team that does not exist: the guard never reveals that a team exists or that it is overdue.
  const stranger = await app.seedUser('Sam Stranger');
  const strangerH = bearer((await app.signIn(stranger.id)).accessToken);
  const missing = await app.post(`/teams/${randomUUID()}/shifts`, { title: 'x', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, strangerH);
  const overdue = await app.post(`/teams/${t.teamId}/shifts`, { title: 'x', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, strangerH);
  assert.equal(overdue.status, 404);
  assert.deepEqual(overdue.body.error.code, missing.body.error.code);
});

test('a team that is merely past due (grace not over) and a team with no subscription are never refused', async () => {
  const t = await setup();
  stripe.renewalScript.push('declined');
  const { paymentIntentId } = await charge(t);
  await deliver(t, { type: 'payment_intent.payment_failed', paymentIntentId: paymentIntentId! });
  assert.equal((await app.post(`/teams/${t.teamId}/invitations/links`, {}, t.ownerH)).status, 201);

  const owner = await app.seedUser('Nina New');
  const fresh = await app.seedTeam({ ownerId: owner.id });
  const res = await app.post(`/teams/${fresh.teamId}/shifts`, { title: 'First', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, bearer((await app.signIn(owner.id)).accessToken));
  assert.equal(res.status, 201);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- retry

test('RETRY: the Owner replaces the card and presses Retry; a double tap is refused; the new attempt has a NEW key and the NEW card; its verified payment lifts the read-only state at once', async () => {
  const { t, paymentIntentId: firstIntent } = await setupReadOnly();
  const refusedBefore = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Late', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, t.ownerH);
  assert.equal(refusedBefore.body.error.code, 'team_read_only');

  const failedBefore = await renewalOf(t.teamId, t.renewalId);
  const newCard = await addCard(t.teamId);

  // Only the Owner may retry.
  assert.equal((await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.managerH)).status, 403);
  const queuedBefore = app.enqueued().length;
  const retry = await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.ownerH);
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  assert.equal(retry.body.renewal.state, 'confirming');
  assert.equal(retry.body.renewal.canRetry, false);
  assert.equal(retry.body.renewal.readOnly, true, 'still read-only until the payment is CONFIRMED');
  // The request did no charging: it queued a job.
  const queued = app.enqueued().slice(queuedBefore);
  assert.equal(queued.length, 1);
  assert.equal(stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId).length, 1);
  // A second tap finds it already requested.
  const second = await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.ownerH);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'payment_in_progress');

  await run(queued);
  const calls = stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.key, `renewal-${t.renewalId}-2`, 'a new attempt is a new key');
  assert.notEqual(calls[1]!.key, calls[0]!.key);
  assert.equal(calls[1]!.request.paymentMethodId, newCard.paymentMethod, 'the NEW card');
  assert.equal(calls[1]!.request.attempt, 2);
  const secondIntent = stripe.renewalIntents.get(calls[1]!.key)!;
  assert.notEqual(secondIntent, firstIntent);

  // A late "failed" event for the FIRST attempt changes nothing.
  const lateStale = await deliver(t, { type: 'payment_intent.payment_failed', paymentIntentId: firstIntent, attempt: 1 });
  assert.equal((await eventRow(lateStale.eventId))!.outcome, 'ignored');
  assert.equal((await renewalOf(t.teamId, t.renewalId)).status, 'charging');

  // The grace period was NOT extended by the retry.
  assert.equal((await renewalOf(t.teamId, t.renewalId)).grace_ends_at.getTime(), failedBefore.grace_ends_at.getTime());

  // The verified payment confirms: the team is writable again immediately.
  const delivered = await deliver(t, { paymentIntentId: secondIntent, attempt: 2, amount: 5000 });
  assert.equal((await eventRow(delivered.eventId))!.outcome, 'applied');
  assert.equal((await renewalOf(t.teamId, t.renewalId)).status, 'paid');
  const after = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Back', startsAt: '2031-06-02T09:00:00.000Z', endsAt: '2031-06-02T17:00:00.000Z' }, t.ownerH);
  assert.equal(after.status, 201, JSON.stringify(after.body));
  const overview = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.equal(overview.body.renewal, null);
  assert.equal((await app.get(`/teams/${t.teamId}`, t.ownerH)).body.billingNotice, null);
  // and only one charge row exists for the renewal
  assert.equal((await ledgerOf(t.teamId)).filter((r) => r.entry_type === 'charge' && r.operation_id === t.renewalId).length, 1);
});

test('RETRY that fails again keeps the first failure date and the same grace end, and sends no further emails', async () => {
  const { t } = await setupReadOnly();
  const failedBefore = await renewalOf(t.teamId, t.renewalId);
  const queuedBefore = app.enqueued().length;
  assert.equal((await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.ownerH)).status, 202);
  stripe.renewalScript.push('declined');
  await run(app.enqueued().slice(queuedBefore));
  const second = stripe.renewalIntents.get(`renewal-${t.renewalId}-2`)!;
  await deliver(t, { type: 'payment_intent.payment_failed', paymentIntentId: second, attempt: 2, errorCode: 'insufficient_funds' });
  const again = await renewalOf(t.teamId, t.renewalId);
  assert.equal(again.status, 'past_due');
  assert.equal(again.failure_code, 'insufficient_funds', 'the latest reason');
  assert.equal(again.failed_at.getTime(), failedBefore.failed_at.getTime());
  assert.equal(again.grace_ends_at.getTime(), failedBefore.grace_ends_at.getTime());
  assert.equal((await emailsOf(t.teamId, t.renewalId)).length, 2);
});

test('retry is refused when nothing is overdue (404) and for a team that is not yours', async () => {
  const t = await setup();
  assert.equal((await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.ownerH)).status, 404);
  const other = await setup();
  const stranger = bearer((await app.signIn(other.owner.id)).accessToken);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, stranger)).status, 404);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- scheduled reductions at the boundary

/** Schedules a reduction directly (the routes only allow it inside the period; here the boundary is what is under test). */
async function scheduleReduction(t: Ctx, target: { plan: string; seats: number }, selected: string[], fallback = false) {
  const sub = await subscriptionOf(t.teamId);
  const rows = await db(t.teamId).$queryRaw<Array<{ id: string }>>`
    INSERT INTO scheduled_changes (team_id, requested_by_user_id, from_period_id, base_version, from_plan, from_seats, target_plan, target_seats, effective_on, selected_member_ids,
      fallback_accepted_at, fallback_wording)
    VALUES (${t.teamId}::uuid, ${t.owner.id}::uuid, ${t.periodId}::uuid, ${sub.version}, ${sub.plan}::billing_plan, ${sub.seats}, ${target.plan}::billing_plan, ${target.seats},
      ${t.endsOn}::date, ${selected}::uuid[], ${fallback ? new Date() : null}, ${fallback ? 'I accept continuing at my current price.' : null})
    RETURNING id::text AS id`;
  return rows[0]!.id;
}
const changeOf = async (teamId: string, id: string) =>
  (await db(teamId).$queryRaw<Array<{ status: string; check_detail: string | null }>>`SELECT status::text AS status, check_detail FROM scheduled_changes WHERE id = ${id}::uuid`)[0]!;
const activeMembers = async (teamId: string) =>
  Number((await db(teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM memberships WHERE team_id = ${teamId}::uuid AND deactivated_at IS NULL`)[0]!.n);

test('a scheduled REDUCTION is applied FIRST, then the renewal charges the smaller amount: the chosen people become inactive only when the payment is confirmed', async () => {
  const t = await setup({ plan: 'team', seats: 9, staff: 3 }); // Owner, Manager and 3 staff: 5 active
  const changeId = await scheduleReduction(t, { plan: 'starter', seats: 3 }, [t.staff[0]!.id, t.staff[1]!.id]);
  assert.equal(await activeMembers(t.teamId), 5);

  const { made, paymentIntentId } = await charge(t);
  // Starter's monthly amount (2000), not the old Team price (5000).
  assert.equal(made[0]!.request.amountCents, 2000);
  assert.equal((await changeOf(t.teamId, changeId)).status, 'ready', 'the boundary check ran inside the renewal');
  const frozen = await renewalOf(t.teamId, t.renewalId);
  assert.deepEqual([frozen.result_plan, frozen.result_seats, frozen.amount_cents, frozen.scheduled_change_id], ['starter', 3, 2000, changeId]);
  // Nothing applied before the webhook: members still active, plan unchanged.
  assert.equal(await activeMembers(t.teamId), 5);
  assert.equal((await subscriptionOf(t.teamId)).plan, 'team');

  await deliver(t, { paymentIntentId: paymentIntentId!, amount: 2000 });
  assert.equal(await activeMembers(t.teamId), 3);
  const inactive = await db(t.teamId).$queryRaw<Array<{ user_id: string }>>`SELECT user_id::text AS user_id FROM memberships WHERE team_id = ${t.teamId}::uuid AND deactivated_at IS NOT NULL ORDER BY user_id`;
  assert.deepEqual(inactive.map((r) => r.user_id).sort(), [t.staff[0]!.id, t.staff[1]!.id].sort());
  assert.equal((await changeOf(t.teamId, changeId)).status, 'applied');
  const sub = await subscriptionOf(t.teamId);
  assert.deepEqual({ plan: sub.plan, seats: sub.seats, paid: sub.paid_basis_cents }, { plan: 'starter', seats: 3, paid: 2000 });
  const ledger = await ledgerOf(t.teamId);
  assert.deepEqual(ledger.slice(2).map((r) => [r.entry_type, r.amount_cents, r.plan, r.seats, r.paid_basis_after_cents]), [['period_start', 0, 'starter', 3, 2000], ['charge', 2000, null, null, null]]);
  const rebuilt = rebuildSubscription(asLedgerRows(ledger));
  assert.deepEqual({ plan: rebuilt.plan, seats: rebuilt.seats, paid: rebuilt.paidBasisCents, version: rebuilt.version }, { plan: 'starter', seats: 3, paid: 2000, version: sub.version });
  // The Owner stays; the deactivated are a non-member on every team route.
  const gone = bearer((await app.signIn(t.staff[0]!.id)).accessToken);
  assert.equal((await app.get(`/teams/${t.teamId}`, gone)).status, 404);
});

test('a reduction that does NOT fit pauses collection: the old, higher price is never charged silently, the team follows the failed-renewal path, and cancelling the reduction is the Owner\'s explicit way out', async () => {
  const t = await setup({ plan: 'team', seats: 9, staff: 3 }); // 5 active
  const changeId = await scheduleReduction(t, { plan: 'starter', seats: 3 }, [t.staff[0]!.id]); // 4 would remain active, 3 seats allowed
  const { made } = await charge(t);
  assert.equal(made.length, 0, 'NOTHING was charged');
  const row = await renewalOf(t.teamId, t.renewalId);
  assert.deepEqual([row.status, row.failure_code], ['past_due', 'reduction_blocked']);
  assert.equal((await changeOf(t.teamId, changeId)).status, 'blocked');
  assert.equal((await emailsOf(t.teamId, t.renewalId)).length, 2);
  const overview = await app.get(billingUrl(t.teamId), t.ownerH);
  assert.match(overview.body.renewal.detail, /reduction you scheduled could not be applied/);
  assert.equal(overview.body.scheduledChange.status, 'blocked');
  assert.equal(overview.body.scheduledChange.canCancel, true);

  // Retrying without fixing anything is still paused (and still charges nothing).
  const q1 = app.enqueued().length;
  assert.equal((await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.ownerH)).status, 202);
  await run(app.enqueued().slice(q1));
  assert.equal(stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId).length, 0);
  assert.equal((await renewalOf(t.teamId, t.renewalId)).failure_code, 'reduction_blocked');

  // The Owner cancels the reduction (keeping the current plan at its current price, on purpose) and retries: now the CURRENT price is charged.
  assert.equal((await app.del(`${billingUrl(t.teamId)}/reductions/current`, t.ownerH)).status, 204);
  const q2 = app.enqueued().length;
  assert.equal((await app.post(`${billingUrl(t.teamId)}/renewal/retry`, {}, t.ownerH)).status, 202);
  await run(app.enqueued().slice(q2));
  const calls = stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.request.amountCents, 5000);
  assert.equal(calls[0]!.request.attempt, 1, 'a paused renewal made no Stripe attempt, so the first real attempt is attempt 1');
});

test('a reduction that does not fit, when the Owner ACCEPTED continuing at the old price, charges the old price and stays "continuing"', async () => {
  const t = await setup({ plan: 'team', seats: 9, staff: 3 });
  const changeId = await scheduleReduction(t, { plan: 'starter', seats: 3 }, [t.staff[0]!.id], true);
  const { made, paymentIntentId } = await charge(t);
  assert.equal(made[0]!.request.amountCents, 5000);
  assert.equal((await changeOf(t.teamId, changeId)).status, 'continuing');
  await deliver(t, { paymentIntentId: paymentIntentId!, amount: 5000 });
  const sub = await subscriptionOf(t.teamId);
  assert.deepEqual([sub.plan, sub.seats], ['team', 9]);
  assert.equal(await activeMembers(t.teamId), 5, 'nobody was made inactive');
  assert.equal((await changeOf(t.teamId, changeId)).status, 'continuing');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- a payment that cannot be applied

test('a payment that does not match what was frozen is RECORDED, applies NOTHING, and goes to human review', async () => {
  const cases: Array<[string, Partial<IntentEventOptions>, string]> = [
    ['wrong amount', { amount: 4999 }, 'amount_mismatch'],
    ['wrong currency', { currency: 'eur' }, 'currency_mismatch'],
    ['a status that is not succeeded', { status: 'processing' }, 'payment_status_processing'],
  ];
  for (const [label, over, reason] of cases) {
    const t = await setup();
    const { paymentIntentId } = await charge(t);
    const ledgerBefore = (await ledgerOf(t.teamId)).length;
    const delivered = await deliver(t, { paymentIntentId: paymentIntentId!, amount: 5000, ...over });
    assert.equal((await eventRow(delivered.eventId))!.outcome, 'review', label);
    const row = await renewalOf(t.teamId, t.renewalId);
    assert.equal(row.status, 'needs_review', label);
    assert.match(row.review_reason, new RegExp(reason), label);
    assert.equal((await ledgerOf(t.teamId)).length, ledgerBefore, `${label}: nothing written to the ledger`);
    assert.equal((await subscriptionOf(t.teamId)).current_period_id, t.periodId, `${label}: the period did not move`);
    assert.equal((await app.get(billingUrl(t.teamId), t.ownerH)).body.renewal.state, 'review');
  }
});

test('a SECOND payment for a renewal that is already paid is recorded for review and applies nothing more', async () => {
  const t = await setup();
  const { paymentIntentId } = await charge(t);
  await deliver(t, { paymentIntentId: paymentIntentId!, amount: 5000 });
  const ledger = (await ledgerOf(t.teamId)).length;
  const extra = await deliver(t, { paymentIntentId: pi('extra'), amount: 5000 });
  assert.equal((await eventRow(extra.eventId))!.outcome, 'review');
  assert.equal((await ledgerOf(t.teamId)).length, ledger);
  assert.equal((await renewalOf(t.teamId, t.renewalId)).stripe_payment_intent_id, paymentIntentId, 'the first payment stays the record');
});

test('a payment event for a renewal that does not exist, or that never charged, is not applied', async () => {
  const t = await setup();
  const ghost = await deliver({ ...t, renewalId: randomUUID() }, { paymentIntentId: pi('ghost'), amount: 5000 });
  assert.equal((await eventRow(ghost.eventId))!.outcome, 'review');
  const never = await deliver(t, { paymentIntentId: pi('never'), amount: 5000 }); // the renewal is still "scheduled": no attempt was frozen
  assert.equal((await eventRow(never.eventId))!.outcome, 'review');
  assert.equal((await ledgerOf(t.teamId)).length, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- the webhook route

test('the webhook acknowledges and ignores the PaymentIntents Checkout makes (no renewal id), refuses a live event and a bad signature, and records only OUR renewal events', async () => {
  const t = await setup();
  const before = Number((await app.raw.A.primary.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM stripe_events WHERE team_id = ${t.teamId}::uuid`)[0]!.n);

  const checkoutIntent = intentEventBody({ paymentIntentId: pi('checkout'), teamId: t.teamId, operationId: randomUUID(), renewalId: null, attempt: null });
  const ignored = await sendWebhook(app.base, checkoutIntent);
  assert.equal(ignored.status, 200);
  const live = await sendWebhook(app.base, intentEventBody({ paymentIntentId: pi('live'), teamId: t.teamId, renewalId: t.renewalId, attempt: 1, livemode: true }));
  assert.equal(live.status, 400);
  const body = intentEventBody({ paymentIntentId: pi('bad'), teamId: t.teamId, renewalId: t.renewalId, attempt: 1 });
  const unsigned = await sendWebhook(app.base, body, { ...signedHeaders(body), 'stripe-signature': 't=1,v1=00' });
  assert.equal(unsigned.status, 400);
  // An event type we do not subscribe to is acknowledged and not recorded.
  const created = await sendWebhook(app.base, JSON.stringify({ ...JSON.parse(body), type: 'payment_intent.created' }));
  assert.equal(created.status, 200);
  assert.equal(Number((await app.raw.A.primary.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM stripe_events WHERE team_id = ${t.teamId}::uuid`)[0]!.n), before);

  const ours = await sendWebhook(app.base, body);
  assert.equal(ours.status, 200);
  const row = await eventRow(JSON.parse(body).id);
  assert.equal(row!.operation_id, t.renewalId);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- scheduling

test('every subscription gets a renewal: ensureRenewals adds the missing ones and is idempotent', async () => {
  const owner = await app.seedUser('Olive Owner');
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id });
  const seeded = await seedActiveSubscription(db(teamId), teamId, { plan: 'starter', seats: 3 }, { requestedByUserId: owner.id }); // no renewal (a pre-P6b subscription)
  assert.equal((await renewalsOf(teamId)).length, 0);
  const queued: string[] = [];
  // Scoped to this one team: the test shards hold the fixtures of every earlier test, and they must not all be given a renewal here.
  const made = await ensureRenewals(app.raw, async (_p, row) => void queued.push(row.id), { teamId });
  assert.equal(made, 1);
  const renewals = await renewalsOf(teamId);
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0]!.period_id, seeded.periodId);
  assert.equal(queued.length, 1);
  assert.equal(await ensureRenewals(app.raw, undefined, { teamId }), 0, 'a second run adds nothing');
  assert.equal((await renewalsOf(teamId)).length, 1);
  void shard;
});

test('ACTIVATION schedules the first renewal in the same transaction: one renewal for the first period, due at its end', async () => {
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, name: 'The Olive Room' });
  const ownerH = bearer((await app.signIn(owner.id)).accessToken);
  const started = await app.post(`${billingUrl(teamId)}/activation`, { plan: 'team', seats: 9 }, { ...ownerH, 'idempotency-key': randomUUID() });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const operationId = started.body.operation.id as string;
  const session = (await db(teamId).$queryRaw<Array<{ s: string }>>`SELECT stripe_checkout_session_id AS s FROM payment_operations WHERE id = ${operationId}::uuid`)[0]!.s;
  const before = app.enqueued().length;
  const res = await sendWebhook(app.base, checkoutEventBody({ sessionId: session, teamId, operationId, amountTotal: 5000, paymentIntent: pi('activation') }));
  assert.equal(res.status, 200);
  stripe.intents.set(pi('activation'), { status: 'succeeded', livemode: false, customerId: 'cus_x', paymentMethodId: `pm_${RUN}_act`, methodType: 'card', card: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2031 }, metadata: {}, usage: 'off_session' });
  await run(app.enqueued().slice(before));

  const renewals = await renewalsOf(teamId);
  assert.equal(renewals.length, 1);
  const period = (await db(teamId).$queryRaw<Array<{ ends_on: string }>>`SELECT ends_on::text AS ends_on FROM billing_periods WHERE id = ${renewals[0]!.period_id}::uuid`)[0]!;
  assert.equal(renewals[0]!.due_at.toISOString(), `${period.ends_on}T00:00:00.000Z`);
  assert.equal(renewals[0]!.status, 'scheduled');
  const work = await db(teamId).$queryRaw<Array<{ run_at: Date; status: string }>>`SELECT run_at, status::text AS status FROM work_rows WHERE kind = 'renewal' AND payload->>'teamId' = ${teamId}`;
  assert.equal(work.length, 1);
  assert.equal(work[0]!.run_at.toISOString(), `${period.ends_on}T00:00:00.000Z`);
  assert.ok(workerQueued.length > 0);
});

test('the renewal job does not run early: before its period ends the work row cannot be claimed', async () => {
  const t = await setup();
  await db(t.teamId).$executeRaw`UPDATE work_rows SET run_at = NOW() + interval '1 hour' WHERE id = ${t.workRow.rowId}::uuid`;
  let delayed = false;
  const processor = createWorkProcessor(app.raw, handlers());
  await processor({ id: 'job-early', data: { rowId: t.workRow.rowId, generation: 1, shard: t.shard }, moveToDelayed: async () => void (delayed = true) } as never, 'lock-token').catch(() => undefined);
  assert.equal(delayed, true);
  assert.equal(stripe.renewalCalls.filter((c) => c.request.renewalId === t.renewalId).length, 0);
  assert.equal((await renewalOf(t.teamId, t.renewalId)).status, 'scheduled');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- the Owner's second email

test('the "now read-only" email is SKIPPED if the renewal was paid before the grace period ended; an unpaid one is sent exactly as stored', async () => {
  const sent: Array<{ to: string[]; subject: string }> = [];
  const resend: ResendClient = { send: async ({ payload }) => (sent.push({ to: payload.to, subject: payload.subject }), { id: `re_${randomUUID()}` }) };
  const processor = createWorkProcessor(app.raw, { email: createEmailHandler({ resend }) });
  const runEmail = (teamId: string, rowId: string, shard: ShardId) => processor({ id: `job-${rowId}-1`, data: { rowId, generation: 1, shard } } as never, undefined);

  // Unpaid: both emails are sent.
  const a = await setup();
  stripe.renewalScript.push('declined');
  const chargeA = await charge(a);
  await deliver(a, { type: 'payment_intent.payment_failed', paymentIntentId: chargeA.paymentIntentId! });
  const mailsA = await emailsOf(a.teamId, a.renewalId);
  for (const m of mailsA) {
    await db(a.teamId).$executeRaw`UPDATE work_rows SET run_at = NOW() - interval '1 minute' WHERE id = ${m.id}::uuid`;
    await runEmail(a.teamId, m.id, a.shard);
  }
  assert.deepEqual(sent.map((s) => s.to[0]), [a.owner.email, a.owner.email]);

  // Paid in between: only the first email goes out.
  sent.length = 0;
  const b = await setup();
  stripe.renewalScript.push('declined');
  const chargeB = await charge(b);
  await deliver(b, { type: 'payment_intent.payment_failed', paymentIntentId: chargeB.paymentIntentId! });
  const mailsB = await emailsOf(b.teamId, b.renewalId);
  const queued = app.enqueued().length;
  assert.equal((await app.post(`${billingUrl(b.teamId)}/renewal/retry`, {}, b.ownerH)).status, 202);
  await run(app.enqueued().slice(queued));
  await deliver(b, { paymentIntentId: stripe.renewalIntents.get(`renewal-${b.renewalId}-2`)!, attempt: 2, amount: 5000 });
  assert.equal((await renewalOf(b.teamId, b.renewalId)).status, 'paid');
  for (const m of mailsB) {
    await db(b.teamId).$executeRaw`UPDATE work_rows SET run_at = NOW() - interval '1 minute' WHERE id = ${m.id}::uuid`;
    await runEmail(b.teamId, m.id, b.shard);
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /could not collect/);
});
