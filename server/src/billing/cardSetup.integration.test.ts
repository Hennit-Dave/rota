import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import type { SavedCardFacts } from './gateway.js';
import { FakeStripe, checkoutEventBody, runStripeJobs, savedCardFacts, sendWebhook } from './stripe.testkit.js';
import { seedActiveSubscription } from './testkit.js';

// Saving a card end to end (ADR 0030): the real routes, the real webhook route, the real job processor, the TEST shards. Only Stripe itself is a fake. Ledger rows can
// never be deleted, so every test uses fresh random teams; saved cards and setups are state and are removed with the team by the harness.
const RUN = randomUUID().slice(0, 8);
const unique = (prefix: string) => `${prefix}_${RUN}_${randomUUID().slice(0, 8)}`;

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

/** An Owner, a Manager and a Staff member of a fresh team. `active` gives it a real subscription (Team, 9 seats) through the fixture a real activation writes. */
async function setup(opts: { active?: boolean; shard?: 'A' | 'B' } = {}) {
  stripe.retrieveScript = [];
  stripe.setupScript = [];
  stripe.script = [];
  const owner = await app.seedUser('Olive Owner');
  const { teamId } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  const staff = await app.seedUser('Sam Staff');
  await app.addMember(teamId, staff.id, 'staff');
  if (opts.active ?? true) await seedActiveSubscription(db(teamId), teamId, { plan: 'team', seats: 9 }, { requestedByUserId: owner.id });
  const h = async (id: string) => bearer((await app.signIn(id)).accessToken);
  return { teamId, owner, ownerH: await h(owner.id), managerH: await h(manager.id), staffH: await h(staff.id), h };
}
type T = Awaited<ReturnType<typeof setup>>;

const anchorDayOf = async (teamId: string) => (await db(teamId).$queryRaw<Array<{ d: number }>>`SELECT billing_anchor_day AS d FROM subscriptions WHERE team_id = ${teamId}::uuid`)[0]!.d;

async function startSetup(t: T, key: string = randomUUID(), headers = t.ownerH) {
  const res = await app.post(`${billingUrl(t.teamId)}/card/setup`, undefined, withKey(headers, key));
  return { res, key, setupId: res.body?.setup?.id as string, checkoutUrl: res.body?.checkoutUrl as string };
}
const setupRow = async (teamId: string, setupId: string) =>
  (await db(teamId).$queryRaw<Array<Record<string, any>>>`
    SELECT status::text AS status, consent_wording, consent_amount_cents, consent_anchor_day, stripe_checkout_session_id, stripe_setup_intent_id, review_reason, completed_at IS NOT NULL AS has_completed_at
    FROM card_setups WHERE id = ${setupId}::uuid`)[0]!;
const cardsOf = (teamId: string) =>
  db(teamId).$queryRaw<Array<Record<string, any>>>`
    SELECT stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, source::text AS source, source_id::text AS source_id,
      consent_wording, consent_amount_cents, consent_anchor_day, status::text AS status, replaced_at IS NOT NULL AS has_replaced_at, removed_at IS NOT NULL AS has_removed_at
    FROM team_payment_methods WHERE team_id = ${teamId}::uuid ORDER BY created_at, id`;
const ledgerCount = async (teamId: string) => Number((await db(teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM ledger_entries WHERE team_id = ${teamId}::uuid`)[0]!.n);
const eventRow = async (eventId: string) =>
  (await app.raw.A.primary.$queryRaw<Array<{ outcome: string | null; processed: boolean; operation_id: string | null }>>`
    SELECT outcome, processed_at IS NOT NULL AS processed, operation_id::text AS operation_id FROM stripe_events WHERE event_id = ${eventId}`)[0];
const eventCount = async (teamId: string) => Number((await app.raw.A.primary.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM stripe_events WHERE team_id = ${teamId}::uuid`)[0]!.n);

interface DeliverOptions {
  /** What Stripe "holds" for the SetupIntent. null: nothing (a read of it is refused). */
  intent?: Partial<SavedCardFacts> | null;
  /** Fields of the event itself. */
  event?: Partial<Parameters<typeof checkoutEventBody>[0]>;
  run?: boolean;
}

/** Sends the signed `checkout.session.completed` (or another type) for a setup and, unless told not to, runs the job it queued, as the worker would. */
async function deliverSetup(t: T, setupId: string, o: DeliverOptions = {}) {
  const sessionId = (await setupRow(t.teamId, setupId)).stripe_checkout_session_id as string;
  const intentId = unique('seti_test');
  const customer = unique('cus_test');
  if (o.intent !== null) {
    stripe.intents.set(intentId, savedCardFacts({ customerId: customer, metadata: { team_id: t.teamId, card_setup_id: setupId }, paymentMethodId: unique('pm_test'), ...o.intent }));
  }
  const before = app.enqueued().length;
  const payload = checkoutEventBody({ sessionId, teamId: t.teamId, cardSetupId: setupId, mode: 'setup', setupIntent: intentId, customer, ...o.event });
  const res = await sendWebhook(app.base, payload);
  const queued = app.enqueued().slice(before);
  if (o.run !== false) await runStripeJobs(app.raw, queued, stripe);
  return { res, payload, eventId: JSON.parse(payload).id as string, queued, intentId, customer };
}

// ---------------------------------------------------------------- saving a card with a setup-mode Checkout

for (const shard of ['A', 'B'] as const) {
  test(`SAVE A CARD on shard ${shard}: Checkout in setup mode -> verified webhook -> job reads the SetupIntent -> an active card with the consent that was shown; nothing is charged`, async () => {
    const t = await setup({ shard });
    const ledgerBefore = await ledgerCount(t.teamId);
    const { res, setupId, checkoutUrl } = await startSetup(t);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
    assert.equal(res.body.status, 'card_setup_required');
    assert.equal(res.body.setup.status, 'awaiting_card');

    // The frozen setup: the consent names the team's own monthly price and anchor day, made by the server.
    const anchor = await anchorDayOf(t.teamId);
    const wording = `By saving this card, you authorise Rota to charge this card the monthly price of your plan and seats, currently $50.00, on day ${anchor} of each month${anchor > 28 ? ' (the last day in shorter months)' : ''} until you remove this card. Test mode only.`;
    const frozen = await setupRow(t.teamId, setupId);
    assert.equal(frozen.status, 'open');
    assert.equal(frozen.consent_wording, wording);
    assert.equal(frozen.consent_amount_cents, 5000);
    assert.equal(frozen.consent_anchor_day, anchor);
    // What was sent to Stripe: the SAME wording, a stable per-setup key, return URLs under the App Link prefix, no existing Customer yet.
    const call = stripe.setupCalls.at(-1)!;
    assert.equal(call.key, `setup-${setupId}`);
    assert.equal(call.request.saveCard.consentText, wording);
    assert.equal(call.request.saveCard.customerId, null);
    assert.equal(call.request.teamId, t.teamId);
    assert.match(call.request.successUrl, new RegExp(`/checkout/card-return\\?setup=${setupId}$`));
    assert.match(call.request.cancelUrl, new RegExp(`/checkout/card-cancel\\?setup=${setupId}$`));
    // Creating the session saves nothing.
    assert.deepEqual(await cardsOf(t.teamId), []);
    assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/${setupId}`, t.ownerH)).body.setup.status, 'awaiting_card');

    const d = await deliverSetup(t, setupId);
    assert.equal(d.res.status, 200);
    assert.deepEqual(await eventRow(d.eventId), { outcome: 'applied', processed: true, operation_id: null });

    const cards = await cardsOf(t.teamId);
    assert.equal(cards.length, 1);
    assert.deepEqual(
      { ...cards[0], stripe_payment_method_id: 'x' },
      {
        stripe_customer_id: d.customer, stripe_payment_method_id: 'x', card_brand: 'visa', card_last4: '4242', card_exp_month: 8, card_exp_year: 2031, source: 'card_setup', source_id: setupId,
        consent_wording: wording, consent_amount_cents: 5000, consent_anchor_day: anchor, status: 'active', has_replaced_at: false, has_removed_at: false,
      },
    );
    const done = await setupRow(t.teamId, setupId);
    assert.equal(done.status, 'completed');
    assert.equal(done.stripe_setup_intent_id, d.intentId);
    assert.equal(done.has_completed_at, true);
    assert.equal(await ledgerCount(t.teamId), ledgerBefore, 'saving a card writes no ledger row: no money moved');

    // The server says saved; the overview shows finished strings and no Stripe id.
    assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/${setupId}`, t.ownerH)).body.setup.status, 'saved');
    const overview = (await app.get(billingUrl(t.teamId), t.ownerH)).body;
    assert.deepEqual({ ...overview.savedCard, consentedOn: 'date' }, { summary: 'Visa ending 4242', expiresDisplay: 'Expires 08/2031', consentWording: wording, consentedOn: 'date' });
    assert.match(overview.savedCard.consentedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(overview.cardConsentWording, wording);
    assert.equal(JSON.stringify(overview).includes(d.customer), false, 'the app is never told a Stripe id');
    assert.equal(JSON.stringify(overview).includes('pm_test'), false);
  });
}

test('THE SAME EVENT THREE TIMES leaves one card, one inbox row and one completed setup', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  const first = await deliverSetup(t, setupId);
  assert.equal((await cardsOf(t.teamId)).length, 1);
  const enqueuedBefore = app.enqueued().length;
  for (let i = 0; i < 3; i++) assert.equal((await sendWebhook(app.base, first.payload)).status, 200);
  assert.equal(app.enqueued().length, enqueuedBefore, 'a processed event is acknowledged and never queued again');
  assert.equal((await cardsOf(t.teamId)).length, 1);
  assert.equal(await eventCount(t.teamId), 1);
  assert.equal((await setupRow(t.teamId, setupId)).status, 'completed');
});

test('TWO DIFFERENT EVENTS for one SetupIntent (a second delivery under a new event id) record the card once: the second is a no-op', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  const one = await deliverSetup(t, setupId);
  // Same SetupIntent, new event id (Stripe can describe one outcome twice).
  const sessionId = (await setupRow(t.teamId, setupId)).stripe_checkout_session_id as string;
  const before = app.enqueued().length;
  const payload = checkoutEventBody({ sessionId, teamId: t.teamId, cardSetupId: setupId, mode: 'setup', setupIntent: one.intentId, customer: one.customer });
  await sendWebhook(app.base, payload);
  await runStripeJobs(app.raw, app.enqueued().slice(before), stripe);
  assert.equal((await eventRow(JSON.parse(payload).id))!.outcome, 'duplicate');
  assert.equal((await cardsOf(t.teamId)).length, 1);
});

test('A CRASH after the card was recorded: the replay finds the setup complete and only finishes the inbox', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  const d = await deliverSetup(t, setupId);
  // Undo only what the crash would have prevented: the inbox mark and the work row's completion. The card and the completed setup stay, as they committed.
  await app.raw.A.primary.$executeRaw`UPDATE stripe_events SET processed_at = NULL, outcome = NULL WHERE event_id = ${d.eventId}`;
  await app.raw.A.primary.$executeRaw`UPDATE work_rows SET status = 'pending'::work_status, claim_token = NULL, claim_expires_at = NULL, execution_attempts = 0 WHERE id = ${d.queued[0]!.rowId}::uuid`;
  assert.equal((await eventRow(d.eventId))!.processed, false);
  await runStripeJobs(app.raw, d.queued, stripe);
  assert.deepEqual(await eventRow(d.eventId), { outcome: 'duplicate', processed: true, operation_id: null });
  assert.equal((await cardsOf(t.teamId)).length, 1);
});

test('A SECOND CARD replaces the first (status replaced, with a time) and goes on the SAME Stripe Customer', async () => {
  const t = await setup();
  const one = await startSetup(t);
  const first = await deliverSetup(t, one.setupId);
  const two = await startSetup(t);
  assert.equal(stripe.setupCalls.at(-1)!.request.saveCard.customerId, first.customer, 'the new Checkout is told which Customer to use');
  await deliverSetup(t, two.setupId, { intent: { customerId: first.customer, card: { brand: 'mastercard', last4: '4444', expMonth: 12, expYear: 2033 } }, event: { customer: first.customer } });
  const cards = await cardsOf(t.teamId);
  assert.deepEqual(cards.map((c) => [c.card_brand, c.card_last4, c.status, c.has_replaced_at]), [['visa', '4242', 'replaced', true], ['mastercard', '4444', 'active', false]]);
  assert.equal((await app.get(billingUrl(t.teamId), t.ownerH)).body.savedCard.summary, 'Mastercard ending 4444');
});

test('A card on ANOTHER Stripe Customer than the team\'s is not recorded: it goes to review', async () => {
  const t = await setup();
  const one = await startSetup(t);
  await deliverSetup(t, one.setupId);
  const two = await startSetup(t);
  const d = await deliverSetup(t, two.setupId); // a fresh customer id, not the team's
  assert.equal((await eventRow(d.eventId))!.outcome, 'review');
  assert.match((await setupRow(t.teamId, two.setupId)).review_reason, /^customer_mismatch/);
  assert.deepEqual((await cardsOf(t.teamId)).map((c) => c.status), ['active'], 'the first card is still the only one');
});

test('REMOVING THE CARD withdraws the authorisation: status removed with a time, gone from the overview, and a second removal is 404', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  await deliverSetup(t, setupId);
  assert.equal((await app.del(`${billingUrl(t.teamId)}/card`, t.staffH)).status, 403);
  assert.equal((await app.del(`${billingUrl(t.teamId)}/card`, t.managerH)).status, 403);
  assert.equal((await cardsOf(t.teamId))[0]!.status, 'active', 'a refused request changes nothing');

  const removed = await app.del(`${billingUrl(t.teamId)}/card`, t.ownerH);
  assert.equal(removed.status, 204);
  const cards = await cardsOf(t.teamId);
  assert.deepEqual([cards[0]!.status, cards[0]!.has_removed_at, cards[0]!.has_replaced_at], ['removed', true, false]);
  assert.equal((await app.get(billingUrl(t.teamId), t.ownerH)).body.savedCard, null);
  const again = await app.del(`${billingUrl(t.teamId)}/card`, t.ownerH);
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'not_found');
  // The Owner can save a card again, and it goes on the same Customer.
  const next = await startSetup(t);
  assert.equal(next.res.status, 201);
  assert.ok(stripe.setupCalls.at(-1)!.request.saveCard.customerId);
});

// ---------------------------------------------------------------- who may do what, and what is refused

test('ONLY THE OWNER, and only of this team: Staff and Manager get 403, no token 401, another team\'s Owner is a stranger (404), and a team that has not activated gets 409', async () => {
  const t = await setup();
  assert.equal((await startSetup(t, randomUUID(), t.staffH)).res.status, 403);
  assert.equal((await startSetup(t, randomUUID(), t.managerH)).res.status, 403);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/card/setup`, undefined, { 'idempotency-key': randomUUID() })).status, 401);
  const stranger = await setup();
  assert.equal((await startSetup(t, randomUUID(), stranger.ownerH)).res.status, 404);
  assert.equal((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM card_setups WHERE team_id = ${t.teamId}::uuid`)[0]!.n, 0n, 'nothing was created by any refused request');

  const mine = await startSetup(t);
  assert.equal((await app.get(`${billingUrl(stranger.teamId)}/card/setups/${mine.setupId}`, stranger.ownerH)).status, 404, 'another team\'s setup looks like one that does not exist');
  assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/${mine.setupId}`, t.staffH)).status, 403);
  assert.equal((await app.post(`${billingUrl(t.teamId)}/card/setups/${mine.setupId}/cancel`, undefined, t.managerH)).status, 403);

  const fresh = await setup({ active: false });
  const notYet = await startSetup(fresh);
  assert.equal(notYet.res.status, 409);
  assert.equal(notYet.res.body.error.code, 'not_activated');
  assert.equal((await app.get(billingUrl(fresh.teamId), fresh.ownerH)).body.cardConsentWording, null, 'no wording is offered before the team has a price to name');
});

test('the request is validated: a missing or malformed Idempotency-Key and a bad id are 400', async () => {
  const t = await setup();
  assert.equal((await app.post(`${billingUrl(t.teamId)}/card/setup`, undefined, t.ownerH)).status, 400, 'no key');
  assert.equal((await app.post(`${billingUrl(t.teamId)}/card/setup`, undefined, withKey(t.ownerH, ''))).status, 400, 'empty key');
  assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/not-a-uuid`, t.ownerH)).status, 400);
});

test('IDEMPOTENCY: the same key returns the stored answer with no second Stripe call; another key while one is open is 409; a key from another request is 422', async () => {
  const t = await setup();
  const first = await startSetup(t);
  const callsBefore = stripe.setupCalls.length;
  const again = await startSetup(t, first.key);
  assert.equal(again.res.status, 200, 'a repeat of the same request');
  assert.equal(again.res.body.checkoutUrl, first.checkoutUrl);
  assert.equal(again.setupId, first.setupId);
  assert.equal(stripe.setupCalls.length, callsBefore, 'no second Stripe call');
  const other = await startSetup(t);
  assert.equal(other.res.status, 409);
  assert.equal(other.res.body.error.code, 'payment_in_progress');
  assert.equal((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM card_setups WHERE team_id = ${t.teamId}::uuid`)[0]!.n, 1n);

  // A key already used by a different request (a paid change) is refused, not answered with that request's stored answer.
  const used = randomUUID();
  const change = await app.post(`${billingUrl(t.teamId)}/changes`, { plan: 'business', seats: 9 }, withKey(t.ownerH, used));
  assert.ok([201, 200, 409].includes(change.status), `the change request ran or was refused on its own terms (${change.status})`);
  if (change.status === 201 || change.status === 200) assert.equal((await startSetup(t, used)).res.status, 422);
});

// ---------------------------------------------------------------- the job matches every field before it records a card

test('MISMATCHES are recorded, not applied, and sent to human review: no card exists afterwards', async () => {
  const cases: Array<{ label: string; over: (t: T, setupId: string) => DeliverOptions; reason: RegExp }> = [
    { label: 'the intent has not succeeded', over: () => ({ intent: { status: 'requires_payment_method' } }), reason: /^intent_requires_payment_method/ },
    { label: 'a card in LIVE mode', over: () => ({ intent: { livemode: true } }), reason: /^live_mode_intent/ },
    { label: 'not saved for off-session use', over: () => ({ intent: { usage: 'on_session' } }), reason: /^not_saved_for_off_session_use/ },
    { label: 'not a card', over: () => ({ intent: { methodType: 'us_bank_account', card: null } }), reason: /^not_a_card/ },
    { label: 'no payment method', over: () => ({ intent: { paymentMethodId: null } }), reason: /^not_a_card/ },
    { label: 'the intent names no Customer', over: () => ({ intent: { customerId: null } }), reason: /^no_customer/ },
    { label: 'the intent\'s Customer is not the session\'s', over: () => ({ intent: { customerId: 'cus_someone_else' } }), reason: /^customer_mismatch/ },
    { label: 'wrong team in the intent metadata', over: () => ({ intent: { metadata: { team_id: randomUUID(), card_setup_id: 'x' } } }), reason: /^metadata_mismatch/ },
    { label: 'wrong setup in the intent metadata', over: (t) => ({ intent: { metadata: { team_id: t.teamId, card_setup_id: randomUUID() } } }), reason: /^metadata_mismatch/ },
    { label: 'wrong Checkout Session', over: () => ({ event: { sessionId: 'cs_test_someone_elses_session' } }), reason: /^session_mismatch/ },
    { label: 'not a setup-mode session', over: () => ({ event: { mode: 'payment' } }), reason: /^not_a_setup_session/ },
    { label: 'no SetupIntent on the session', over: () => ({ event: { setupIntent: null } }), reason: /^setup_intent_missing/ },
    { label: 'no Customer on the session', over: () => ({ event: { customer: null } }), reason: /^customer_missing/ },
    { label: 'Stripe refuses the read (no such intent)', over: () => ({ intent: null }), reason: /^stripe_rejected_/ },
  ];
  for (const c of cases) {
    const t = await setup();
    const { setupId } = await startSetup(t);
    const d = await deliverSetup(t, setupId, c.over(t, setupId));
    assert.equal(d.res.status, 200, c.label);
    assert.equal((await eventRow(d.eventId))!.outcome, 'review', c.label);
    const row = await setupRow(t.teamId, setupId);
    assert.equal(row.status, 'needs_review', c.label);
    assert.match(row.review_reason, c.reason, c.label);
    assert.deepEqual(await cardsOf(t.teamId), [], `${c.label}: no card`);
  }
});

test('an event naming this setup under ANOTHER team finds nothing and changes nothing', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  const other = randomUUID();
  const d = await deliverSetup(t, setupId, { event: { teamId: other } });
  assert.equal((await eventRow(d.eventId))!.outcome, 'review');
  assert.equal((await setupRow(t.teamId, setupId)).status, 'open', 'the real team\'s setup is untouched');
  assert.deepEqual(await cardsOf(t.teamId), []);
  // This event names a team that does not exist, so the harness cleanup (by team) will not find it.
  await app.raw.A.primary.$executeRaw`DELETE FROM stripe_events WHERE event_id = ${d.eventId}`;
  await app.raw.A.primary.$executeRaw`DELETE FROM work_rows WHERE kind = 'stripe_event' AND payload->>'teamId' = ${other}`;
});

test('a card Stripe would not save: the buyer\'s card is refused on Stripe\'s page, Stripe sends nothing, and the setup stays open until it expires with no card', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  // Card 4000 0000 0000 0002 cannot be attached to a Customer (Stripe's testing docs): Stripe's page refuses it and no completed event follows.
  assert.deepEqual(await cardsOf(t.teamId), []);
  assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/${setupId}`, t.ownerH)).body.setup.status, 'awaiting_card');
  const expired = await deliverSetup(t, setupId, { intent: null, event: { type: 'checkout.session.expired' } });
  assert.equal((await eventRow(expired.eventId))!.outcome, 'applied');
  assert.equal((await setupRow(t.teamId, setupId)).status, 'expired');
  assert.deepEqual(await cardsOf(t.teamId), []);
  assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/${setupId}`, t.ownerH)).body.setup.status, 'expired');
  assert.equal((await startSetup(t)).res.status, 201, 'the team can try again');
});

test('CANCEL ends an open setup so the buyer can try again at once; a card saved on the cancelled Checkout is recorded for review, never silently kept', async () => {
  const t = await setup();
  const one = await startSetup(t);
  const cancelled = await app.post(`${billingUrl(t.teamId)}/card/setups/${one.setupId}/cancel`, undefined, t.ownerH);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.setup.status, 'expired');
  assert.equal((await startSetup(t)).res.status, 201);
  // The buyer finished the OLD Checkout anyway within its lifetime: that card is not applied.
  const late = await deliverSetup(t, one.setupId);
  assert.equal((await eventRow(late.eventId))!.outcome, 'review');
  assert.match((await setupRow(t.teamId, one.setupId)).review_reason, /^completed_after_expired/);
  assert.deepEqual(await cardsOf(t.teamId), []);
});

test('a setup whose card is being recorded cannot be cancelled', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  await deliverSetup(t, setupId, { run: false }); // the verified event is recorded, the job has not run: "confirming"
  assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/${setupId}`, t.ownerH)).body.setup.status, 'confirming');
  const refused = await app.post(`${billingUrl(t.teamId)}/card/setups/${setupId}/cancel`, undefined, t.ownerH);
  assert.equal(refused.status, 409);
  assert.equal((await setupRow(t.teamId, setupId)).status, 'open');
});

test('STRIPE DOWN when the job reads the intent: the job fails and is retried, the inbox row stays unprocessed, and the retry records the card once', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  stripe.retrieveScript = ['uncertain'];
  const d = await deliverSetup(t, setupId, { run: false });
  await assert.rejects(runStripeJobs(app.raw, d.queued, stripe));
  assert.deepEqual(await eventRow(d.eventId), { outcome: null, processed: false, operation_id: null });
  assert.deepEqual(await cardsOf(t.teamId), []);
  assert.equal((await app.get(`${billingUrl(t.teamId)}/card/setups/${setupId}`, t.ownerH)).body.setup.status, 'confirming');
  await runStripeJobs(app.raw, d.queued, stripe); // the retry
  assert.equal((await eventRow(d.eventId))!.outcome, 'applied');
  assert.equal((await cardsOf(t.teamId)).length, 1);
});

test('STRIPE REFUSES to create the session: 503, the setup is closed as failed so the team is not blocked, and a new attempt is allowed', async () => {
  const t = await setup();
  stripe.setupScript = ['rejected'];
  const bad = await startSetup(t);
  assert.equal(bad.res.status, 503);
  const rows = await db(t.teamId).$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM card_setups WHERE team_id = ${t.teamId}::uuid`;
  assert.deepEqual(rows.map((r) => r.status), ['failed']);
  assert.equal((await startSetup(t, bad.key)).res.status, 503, 'the same key gets the same remembered answer');
  assert.equal((await startSetup(t)).res.status, 201);
});

test('AN UNKNOWN OUTCOME from Stripe leaves the setup open, and the same key resumes it: Stripe returns the session it already made', async () => {
  const t = await setup();
  stripe.setupScript = ['uncertain_after_create'];
  const key = randomUUID();
  const first = await startSetup(t, key);
  assert.equal(first.res.status, 503);
  const sessionsBefore = stripe.setupCalls.length;
  const resumed = await startSetup(t, key);
  assert.equal(resumed.res.status, 201);
  assert.equal(stripe.setupCalls.length, sessionsBefore + 1);
  assert.equal(stripe.setupCalls.at(-1)!.key, stripe.setupCalls.at(-2)!.key, 'the same Stripe idempotency key');
  assert.equal((await db(t.teamId).$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM card_setups WHERE team_id = ${t.teamId}::uuid`)[0]!.n, 1n);
});

test('a LIVE-mode event is refused at the webhook and nothing is recorded', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  const d = await deliverSetup(t, setupId, { event: { livemode: true }, run: false });
  assert.equal(d.res.status, 400);
  assert.equal(await eventCount(t.teamId), 0);
});

test('THE DATABASE ITSELF allows one active card and one open setup per team, and refuses the same Stripe card twice', async () => {
  const t = await setup();
  const { setupId } = await startSetup(t);
  await deliverSetup(t, setupId, { intent: { paymentMethodId: unique('pm_dup') } });
  const [card] = await cardsOf(t.teamId);
  const insert = (id: string, pm: string, status: string) => db(t.teamId).$executeRaw`
    INSERT INTO team_payment_methods (team_id, stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, source, source_id, consent_wording,
      consent_amount_cents, consent_anchor_day, consented_at, status, replaced_at)
    VALUES (${t.teamId}::uuid, 'cus_x', ${pm}, 'visa', '4242', 1, 2030, 'card_setup'::saved_card_source, ${id}::uuid, 'w', 5000, 1, NOW(), ${status}::saved_card_status, ${status === 'replaced' ? new Date() : null})`;
  await assert.rejects(insert(randomUUID(), unique('pm_second_active'), 'active'), /team_payment_methods_one_active_per_team/);
  await assert.rejects(insert(randomUUID(), card!.stripe_payment_method_id, 'replaced'), /team_payment_methods_stripe_payment_method_id_key/);
  await insert(randomUUID(), unique('pm_old'), 'replaced'); // history rows are fine
  const open = await startSetup(t);
  assert.equal(open.res.status, 201);
  await assert.rejects(
    db(t.teamId).$executeRaw`INSERT INTO card_setups (team_id, requested_by_user_id, consent_wording, consent_amount_cents, consent_anchor_day, expires_at) VALUES (${t.teamId}::uuid, ${t.owner.id}::uuid, 'w', 5000, 1, NOW() + interval '1 hour')`,
    /card_setups_one_open_per_team/,
  );
});

// ---------------------------------------------------------------- activation: the card saved by the payment

async function activate(t: T, plan = 'team', seats = 9) {
  const res = await app.post(`${billingUrl(t.teamId)}/activation`, { plan, seats }, withKey(t.ownerH));
  const operationId = res.body?.operation?.id as string;
  const op = (await db(t.teamId).$queryRaw<Array<Record<string, any>>>`SELECT stripe_checkout_session_id, consent_wording, quote_cents, activation_date::text AS activation_date FROM payment_operations WHERE id = ${operationId}::uuid`)[0]!;
  return { res, operationId, sessionId: op.stripe_checkout_session_id as string, op };
}

async function deliverPayment(t: T, a: { operationId: string; sessionId: string }, o: { intent?: Partial<SavedCardFacts> | null; event?: Partial<Parameters<typeof checkoutEventBody>[0]>; amount?: number; run?: boolean } = {}) {
  const pi = unique('pi_test');
  const customer = unique('cus_test');
  if (o.intent !== null) stripe.intents.set(pi, savedCardFacts({ customerId: customer, metadata: { team_id: t.teamId, operation_id: a.operationId }, paymentMethodId: unique('pm_test'), ...o.intent }));
  const before = app.enqueued().length;
  const payload = checkoutEventBody({ sessionId: a.sessionId, teamId: t.teamId, operationId: a.operationId, amountTotal: o.amount ?? 5000, paymentIntent: pi, customer, ...o.event });
  const res = await sendWebhook(app.base, payload);
  const queued = app.enqueued().slice(before);
  if (o.run !== false) await runStripeJobs(app.raw, queued, stripe);
  return { res, payload, eventId: JSON.parse(payload).id as string, queued, pi, customer };
}

const subscriptionOf = async (teamId: string) => (await db(teamId).$queryRaw<Array<Record<string, any>>>`SELECT plan::text AS plan, seats, version FROM subscriptions WHERE team_id = ${teamId}::uuid`)[0];

test('ACTIVATION SAVES THE CARD: the quote shows the wording, Checkout is asked to save the card with that wording, and the verified payment leaves an active card with the consent', async () => {
  const t = await setup({ active: false });
  const quote = await app.get(`${billingUrl(t.teamId)}/activation-quote?plan=team&seats=9`, t.ownerH);
  const today = new Date().getUTCDate();
  const expected = `By paying, you authorise Rota to charge this card the monthly price of your plan and seats, currently $50.00, on day ${today} of each month${today > 28 ? ' (the last day in shorter months)' : ''} until you remove this card. Test mode only.`;
  assert.equal(quote.body.quote.consentWording, expected);

  const a = await activate(t);
  assert.equal(a.res.status, 201, JSON.stringify(a.res.body));
  assert.equal(a.op.consent_wording, expected, 'frozen on the operation');
  const asked = stripe.calls.at(-1)!.request;
  assert.deepEqual(asked.saveCard, { consentText: expected, customerId: null });
  assert.deepEqual(await cardsOf(t.teamId), [], 'nothing is saved until the verified event');

  const d = await deliverPayment(t, a);
  assert.equal((await eventRow(d.eventId))!.outcome, 'applied');
  assert.equal((await subscriptionOf(t.teamId))!.version, 1);
  const cards = await cardsOf(t.teamId);
  assert.equal(cards.length, 1);
  assert.deepEqual(
    { ...cards[0], stripe_payment_method_id: 'x' },
    {
      stripe_customer_id: d.customer, stripe_payment_method_id: 'x', card_brand: 'visa', card_last4: '4242', card_exp_month: 8, card_exp_year: 2031, source: 'activation', source_id: a.operationId,
      consent_wording: expected, consent_amount_cents: 5000, consent_anchor_day: today, status: 'active', has_replaced_at: false, has_removed_at: false,
    },
  );
  assert.equal((await app.get(billingUrl(t.teamId), t.ownerH)).body.savedCard.summary, 'Visa ending 4242');
});

test('THE ACTIVATION EVENT THREE TIMES: one payment, one set of ledger rows, one card', async () => {
  const t = await setup({ active: false });
  const a = await activate(t);
  const first = await deliverPayment(t, a);
  const ledger = await ledgerCount(t.teamId);
  const enqueuedBefore = app.enqueued().length;
  for (let i = 0; i < 3; i++) assert.equal((await sendWebhook(app.base, first.payload)).status, 200);
  assert.equal(app.enqueued().length, enqueuedBefore);
  assert.equal(await ledgerCount(t.teamId), ledger);
  assert.equal((await cardsOf(t.teamId)).length, 1);
  // A second event for the SAME payment (async success after completed) is a no-op for the card too.
  const second = await deliverPayment(t, a, { intent: null, event: { type: 'checkout.session.async_payment_succeeded', paymentIntent: first.pi } });
  assert.equal((await eventRow(second.eventId))!.outcome, 'duplicate');
  assert.equal((await cardsOf(t.teamId)).length, 1);
});

test('A CARD THAT CANNOT BE SAVED NEVER UNDOES THE PAYMENT: the activation stands, the team simply has no card (it follows the failed-renewal path later)', async () => {
  const cases: Array<{ label: string; intent: Partial<SavedCardFacts> | null }> = [
    { label: 'Stripe has no such intent', intent: null },
    { label: 'the card was not saved for off-session use', intent: { usage: null } },
    { label: 'not a card', intent: { methodType: 'link', card: null } },
    { label: 'wrong operation in the metadata', intent: { metadata: { team_id: 'x', operation_id: randomUUID() } } },
    { label: 'the intent\'s Customer is not the session\'s', intent: { customerId: 'cus_someone_else' } },
  ];
  for (const c of cases) {
    const t = await setup({ active: false });
    const a = await activate(t);
    const d = await deliverPayment(t, a, { intent: c.intent });
    assert.equal((await eventRow(d.eventId))!.outcome, 'applied', c.label);
    assert.equal((await subscriptionOf(t.teamId))!.version, 1, `${c.label}: the payment applied`);
    assert.equal((await ledgerCount(t.teamId)) > 0, true, c.label);
    assert.deepEqual(await cardsOf(t.teamId), [], `${c.label}: no card`);
    assert.equal((await app.get(billingUrl(t.teamId), t.ownerH)).body.savedCard, null, c.label);
  }
});

test('STRIPE DOWN when reading the payment\'s card: the job is retried, the payment is not applied twice, and the retry saves the card', async () => {
  const t = await setup({ active: false });
  const a = await activate(t);
  stripe.retrieveScript = ['uncertain'];
  const d = await deliverPayment(t, a, { run: false });
  await assert.rejects(runStripeJobs(app.raw, d.queued, stripe));
  assert.equal((await subscriptionOf(t.teamId))!.version, 1, 'the payment applied before the card step');
  assert.equal((await eventRow(d.eventId))!.processed, false);
  const ledger = await ledgerCount(t.teamId);
  await runStripeJobs(app.raw, d.queued, stripe);
  assert.equal(await ledgerCount(t.teamId), ledger, 'no second set of ledger rows');
  assert.equal((await subscriptionOf(t.teamId))!.version, 1);
  assert.equal((await cardsOf(t.teamId)).length, 1);
  assert.equal((await eventRow(d.eventId))!.processed, true);
});

test('an activation made BEFORE this slice (no consent wording on its operation) is applied as before and asks nothing about a card', async () => {
  const t = await setup({ active: false });
  const a = await activate(t);
  await db(t.teamId).$executeRaw`UPDATE payment_operations SET consent_wording = NULL WHERE id = ${a.operationId}::uuid`;
  const d = await deliverPayment(t, a);
  assert.equal((await eventRow(d.eventId))!.outcome, 'applied');
  assert.deepEqual(await cardsOf(t.teamId), []);
  assert.equal(stripe.retrieved.includes(d.pi), false, 'Stripe was not even asked');
});

test('A PAID CHANGE saves no card and asks Stripe for none (the payment path of P4 is unchanged)', async () => {
  const t = await setup();
  const change = await app.post(`${billingUrl(t.teamId)}/changes`, { plan: 'business', seats: 9 }, withKey(t.ownerH));
  assert.equal(change.status, 201, JSON.stringify(change.body));
  assert.equal(stripe.calls.at(-1)!.request.saveCard, undefined);
  const op = (await db(t.teamId).$queryRaw<Array<{ consent_wording: string | null }>>`SELECT consent_wording FROM payment_operations WHERE id = ${change.body.operation.id}::uuid`)[0]!;
  assert.equal(op.consent_wording, null);
});

test('a second activation card for a team whose card is on another Customer is not recorded (its payment still stands)', async () => {
  const t = await setup({ active: false });
  // The team already has a card on a Customer of its own, from an earlier save.
  await db(t.teamId).$executeRaw`
    INSERT INTO team_payment_methods (team_id, stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, source, source_id, consent_wording,
      consent_amount_cents, consent_anchor_day, consented_at)
    VALUES (${t.teamId}::uuid, ${unique('cus_first')}, ${unique('pm_first')}, 'visa', '4242', 1, 2030, 'card_setup'::saved_card_source, ${randomUUID()}::uuid, 'w', 5000, 1, NOW())`;
  const a = await activate(t);
  assert.ok(stripe.calls.at(-1)!.request.saveCard!.customerId, 'Checkout is told to use the team\'s Customer');
  const d = await deliverPayment(t, a); // a different customer comes back
  assert.equal((await eventRow(d.eventId))!.outcome, 'applied');
  assert.equal((await subscriptionOf(t.teamId))!.version, 1);
  assert.equal((await cardsOf(t.teamId)).length, 1, 'still just the first card');
});
