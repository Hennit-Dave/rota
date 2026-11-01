import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Stripe from 'stripe';
import { createStripeGateway, renewalIdempotencyKey, StripeCardDeclinedError, StripeRejectedError, StripeUncertainError } from './gateway.js';
import { applyQuoteToState, ledgerRowsForActivation, ledgerRowsForRenewal, rebuildSubscription, type LedgerRow } from './ledger.js';
import { monthlyCents } from './plans.js';
import { periodAfter, periodNumber } from './periods.js';
import { DEFAULT_GRACE_DAYS, graceEndsAt, loadRenewalConfig } from './renewalConfig.js';
import { renderRenewalFailedEmail, renderTeamReadOnlyEmail, type NoticeInput } from './renewalNotice.js';
import { describeRenewal, failureSentence, noticeFor, type RenewalStateRow } from './renewalState.js';
import { ourRenewalMetadata, paymentIntentEvent, renewalPaymentJobPayload } from './stripeEvent.js';
import { intentEventBody } from './stripe.testkit.js';

// ---- the next period (money.md: calendar-month anniversaries, the anchor is never changed by clamping)

test('the period after one that ends on a given day starts that day and ends on the anchor day of the next month, clamped to its last day', () => {
  assert.deepEqual(periodAfter('2026-11-15', 15), { startsOn: '2026-11-15', endsOn: '2026-12-15', periodDays: 30 });
  // Anchor 31: Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31, never dragged back by February.
  assert.deepEqual(periodAfter('2027-01-31', 31), { startsOn: '2027-01-31', endsOn: '2027-02-28', periodDays: 28 });
  assert.deepEqual(periodAfter('2027-02-28', 31), { startsOn: '2027-02-28', endsOn: '2027-03-31', periodDays: 31 });
  assert.deepEqual(periodAfter('2027-03-31', 31), { startsOn: '2027-03-31', endsOn: '2027-04-30', periodDays: 30 });
  assert.deepEqual(periodAfter('2028-01-31', 31), { startsOn: '2028-01-31', endsOn: '2028-02-29', periodDays: 29 }, 'a leap year');
  assert.deepEqual(periodAfter('2026-12-20', 20), { startsOn: '2026-12-20', endsOn: '2027-01-20', periodDays: 31 }, 'across the new year');
  assert.throws(() => periodAfter('2026-11-15', 32));
  assert.throws(() => periodAfter('2026-11-15', 0));
});

test('periodAfter agrees with the calendar from the activation date, period after period, for every anchor day', () => {
  for (const anchor of [1, 15, 28, 29, 30, 31]) {
    const activation = `2026-01-${String(anchor).padStart(2, '0')}`;
    let current = periodNumber(activation, 0);
    for (let index = 1; index <= 30; index++) {
      const next = periodAfter(current.endsOn, anchor);
      assert.deepEqual(next, periodNumber(activation, index), `anchor ${anchor}, period ${index}`);
      current = next;
    }
  }
});

// ---- the grace period (a config value; Dave chose 7)

test('the grace period is 7 days unless RENEWAL_GRACE_DAYS says otherwise, and a bad value stops the process', () => {
  assert.equal(DEFAULT_GRACE_DAYS, 7);
  assert.deepEqual(loadRenewalConfig({}), { graceDays: 7 });
  assert.deepEqual(loadRenewalConfig({ RENEWAL_GRACE_DAYS: '' }), { graceDays: 7 });
  assert.deepEqual(loadRenewalConfig({ RENEWAL_GRACE_DAYS: '3' }), { graceDays: 3 });
  for (const bad of ['0', '-1', '1.5', 'seven', '1000', ' 7']) assert.throws(() => loadRenewalConfig({ RENEWAL_GRACE_DAYS: bad }), /RENEWAL_GRACE_DAYS/, bad);
});

test('the grace period ends exactly N whole days after the first failure', () => {
  assert.equal(graceEndsAt(new Date('2026-11-01T10:30:00.000Z'), 7).toISOString(), '2026-11-08T10:30:00.000Z');
  assert.equal(graceEndsAt(new Date('2026-11-01T10:30:00.000Z'), 1).toISOString(), '2026-11-02T10:30:00.000Z');
});

// ---- the ledger: a renewal is one operation that starts the next period

test('a renewal writes a period start (the entitlements and the amount it was paid at) and the full monthly charge, and the ledger still rebuilds the subscription', () => {
  const firstPeriod = randomUUID();
  const nextPeriod = randomUUID();
  const renewalId = randomUUID();
  const rows: LedgerRow[] = [
    ...ledgerRowsForActivation({ operationId: randomUUID(), periodId: firstPeriod, entitlements: { plan: 'team', seats: 9 } }),
    // The team scheduled a reduction to Starter, 5 seats: the renewal starts the new period with it, at its price.
    ...ledgerRowsForRenewal({ operationId: renewalId, periodId: nextPeriod, entitlements: { plan: 'starter', seats: 5 } }),
  ];
  assert.deepEqual(
    rows.slice(2).map((r) => [r.entryType, r.sequence, r.amountCents, r.plan, r.seats, r.paidBasisAfterCents, r.periodId]),
    [['period_start', 1, 0, 'starter', 5, 2000, nextPeriod], ['charge', 1, 2000, null, null, null, nextPeriod]],
  );
  assert.deepEqual(rebuildSubscription(rows), { plan: 'starter', seats: 5, paidBasisCents: 2000, currentPeriodId: nextPeriod, version: 2 });
  assert.equal(monthlyCents({ plan: 'starter', seats: 5 }), 2000);
  void applyQuoteToState;
});

// ---- the Stripe request (the one call the worker makes)

const config = { secretKey: 'sk_test_unused_no_network_in_tests', timeoutMs: 1000 };
const charge = { renewalId: randomUUID(), teamId: randomUUID(), attempt: 1, amountCents: 5000, customerId: 'cus_test_1', paymentMethodId: 'pm_test_1' };

function clientWith(create: (params: any, options: any) => Promise<unknown>): Stripe {
  const client = new Stripe(config.secretKey);
  (client.paymentIntents as any).create = create;
  return client;
}

test('the renewal charge: our integer amount, off-session, confirmed at once, the saved card, our ids in metadata, and a key that is stable per attempt', async () => {
  let seen: any;
  const gateway = createStripeGateway(config, clientWith(async (params, options) => ((seen = { params, options }), { id: 'pi_test_1', status: 'succeeded', livemode: false })));
  assert.deepEqual(await gateway.createRenewalPayment(charge), { paymentIntentId: 'pi_test_1', status: 'succeeded' });
  assert.equal(seen.params.amount, 5000);
  assert.equal(seen.params.currency, 'usd');
  assert.equal(seen.params.customer, 'cus_test_1');
  assert.equal(seen.params.payment_method, 'pm_test_1');
  assert.equal(seen.params.off_session, true);
  assert.equal(seen.params.confirm, true);
  assert.deepEqual(seen.params.metadata, { team_id: charge.teamId, renewal_id: charge.renewalId, attempt: '1' });
  assert.equal(seen.options.idempotencyKey, `renewal-${charge.renewalId}-1`);
  assert.equal(seen.options.idempotencyKey, renewalIdempotencyKey(charge.renewalId, 1));
  // No Stripe Subscription anywhere (AGENTS.md): a one-time PaymentIntent we create ourselves.
  for (const key of ['subscription', 'subscription_data', 'items', 'mode']) assert.equal(key in seen.params, false, key);
  // A retry by the Owner is a NEW attempt, so a NEW key (Stripe would hand back the failed first result for the old one).
  assert.notEqual(renewalIdempotencyKey(charge.renewalId, 2), renewalIdempotencyKey(charge.renewalId, 1));
});

test('a refused card is a declined error carrying the PaymentIntent Stripe made; a bad request is a rejection; a timeout is uncertain; a LIVE payment is refused', async () => {
  const fail = (err: unknown) => createStripeGateway(config, clientWith(async () => { throw err; })).createRenewalPayment(charge);
  const declined = new Stripe.errors.StripeCardError({ type: 'card_error', code: 'card_declined', message: 'Your card was declined.', payment_intent: { id: 'pi_test_declined' } } as any);
  await assert.rejects(fail(declined), (e: unknown) => e instanceof StripeCardDeclinedError && e.paymentIntentId === 'pi_test_declined' && e.code === 'card_declined');
  const noIntent = new Stripe.errors.StripeCardError({ type: 'card_error', code: 'authentication_required', message: 'x' } as any);
  await assert.rejects(fail(noIntent), (e: unknown) => e instanceof StripeCardDeclinedError && e.paymentIntentId === null && e.code === 'authentication_required');
  await assert.rejects(fail(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'No such customer' })), StripeRejectedError);
  await assert.rejects(fail(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'timeout' })), StripeUncertainError);
  const live = createStripeGateway(config, clientWith(async () => ({ id: 'pi_live_1', status: 'succeeded', livemode: true })));
  await assert.rejects(live.createRenewalPayment(charge), (e: Error) => e instanceof StripeRejectedError && /live_mode_payment/.test(e.message));
});

// ---- the events (only a verified PaymentIntent event for OUR renewal is recorded)

test('a PaymentIntent event is ours only with a team, a renewal and an attempt in its metadata; the ones Checkout makes are not', () => {
  const teamId = randomUUID();
  const renewalId = randomUUID();
  assert.deepEqual(ourRenewalMetadata({ team_id: teamId, renewal_id: renewalId, attempt: '2' }), { teamId, renewalId, attempt: 2 });
  assert.equal(ourRenewalMetadata({ team_id: teamId, operation_id: randomUUID() }), null, 'an activation or paid change PaymentIntent');
  for (const bad of [{ team_id: teamId, renewal_id: renewalId } as Record<string, string>, { team_id: teamId, renewal_id: renewalId, attempt: '0' }, { team_id: teamId, renewal_id: 'x', attempt: '1' }, { team_id: 'x', renewal_id: renewalId, attempt: '1' }, { team_id: teamId, renewal_id: renewalId, attempt: '1.5' }]) {
    assert.equal(ourRenewalMetadata(bad), null, JSON.stringify(bad));
  }
  assert.equal(ourRenewalMetadata(null), null);
});

test('the PaymentIntent event schema keeps only what the job needs and the job payload demands the rest', () => {
  const teamId = randomUUID();
  const renewalId = randomUUID();
  const body = JSON.parse(intentEventBody({ paymentIntentId: 'pi_test_1', teamId, renewalId, attempt: 1, type: 'payment_intent.payment_failed', errorCode: 'authentication_required' }));
  const parsed = paymentIntentEvent.parse(body);
  assert.equal(parsed.data.object.last_payment_error?.code, 'authentication_required');
  assert.equal('customer' in parsed.data.object, false, 'unknown fields are dropped');
  assert.equal(paymentIntentEvent.safeParse({ ...body, type: 'payment_intent.created' }).success, false);
  assert.equal(renewalPaymentJobPayload.safeParse({ purpose: 'renewal_payment', eventId: 'evt_1', type: 'payment_intent.succeeded', paymentIntentId: 'pi_1', status: 'succeeded', amount: 5000, currency: 'usd', teamId, renewalId, attempt: 1, failureCode: null }).success, true);
  assert.equal(renewalPaymentJobPayload.safeParse({ purpose: 'renewal_payment', eventId: 'evt_1', type: 'payment_intent.succeeded', paymentIntentId: 'pi_1', status: 'succeeded', amount: 5000, currency: 'usd', teamId, renewalId, attempt: 0, failureCode: null }).success, false);
});

// ---- what the people in the team are told

const NOW = new Date('2026-11-10T12:00:00.000Z');
const row = (over: Partial<RenewalStateRow>): RenewalStateRow => ({ status: 'past_due', failure_code: 'card_declined', failed_at: new Date('2026-11-09T00:00:00.000Z'), grace_ends_at: new Date('2026-11-16T00:00:00.000Z'), amount_cents: 5000, plan: 'team', seats: 9, ...over });

test('a healthy renewal (waiting for its date, or paid) shows nothing', () => {
  assert.equal(describeRenewal(undefined, NOW), null);
  assert.equal(describeRenewal(row({ status: 'scheduled', failed_at: null, grace_ends_at: null, failure_code: null }), NOW), null);
  assert.equal(describeRenewal(row({ status: 'paid' }), NOW), null);
});

test('PAST DUE inside the grace period: full access, the last day named, the reason in plain words, the Owner can retry', () => {
  const view = describeRenewal(row({}), NOW)!;
  assert.equal(view.state, 'past_due');
  assert.equal(view.readOnly, false);
  assert.equal(view.canRetry, true);
  assert.equal(view.amountDisplay, '$50.00');
  assert.equal(view.graceEndsOn, '2026-11-16');
  assert.match(view.detail, /Your card was declined\./);
  assert.match(view.detail, /full access until 2026-11-16/);
});

test('READ-ONLY once the grace period has ended and nothing was paid; the Owner can still retry', () => {
  const view = describeRenewal(row({ grace_ends_at: new Date('2026-11-10T12:00:00.000Z') }), NOW)!;
  assert.equal(view.state, 'read_only');
  assert.equal(view.readOnly, true);
  assert.equal(view.canRetry, true);
  assert.match(view.detail, /Nobody can change shifts, swaps or invitations/);
  assert.match(view.detail, /Billing/);
});

test('a retry in flight shows "confirming", cannot be pressed again, and stays read-only if the grace period had already ended', () => {
  const inside = describeRenewal(row({ status: 'retry_requested' }), NOW)!;
  assert.deepEqual([inside.state, inside.readOnly, inside.canRetry], ['confirming', false, false]);
  const after = describeRenewal(row({ status: 'charging', grace_ends_at: new Date('2026-11-01T00:00:00.000Z') }), NOW)!;
  assert.deepEqual([after.state, after.readOnly, after.canRetry], ['confirming', true, false]);
});

test('a payment that needs a human shows "checking", with no retry', () => {
  const view = describeRenewal(row({ status: 'needs_review' }), NOW)!;
  assert.deepEqual([view.state, view.canRetry], ['review', false]);
});

test('before any charge the amount is the subscription\'s own monthly amount, made by the server', () => {
  const view = describeRenewal(row({ failure_code: 'no_card', amount_cents: null, plan: 'team', seats: 18 }), NOW)!;
  assert.equal(view.amountDisplay, '$59.00'); // Team 18 seats: 5000 + 3 x 300
  assert.match(view.detail, /no saved card/);
});

test('every failure code has a sentence, and an unknown Stripe code gets the general one', () => {
  for (const code of ['no_card', 'reduction_blocked', 'authentication_required', 'expired_card', 'insufficient_funds', 'charge_refused', 'charge_unconfirmed', 'card_declined']) {
    assert.ok(failureSentence(code).length > 10, code);
  }
  assert.equal(failureSentence('something_new'), 'Your card was declined.');
  assert.equal(failureSentence(null), 'Your card was declined.');
});

test('the Owner sees the full words; everyone else is told only once the team is read-only', () => {
  const pastDue = describeRenewal(row({}), NOW);
  const readOnly = describeRenewal(row({ grace_ends_at: new Date('2026-11-09T01:00:00.000Z') }), NOW);
  assert.equal(noticeFor(null, 'owner'), null);
  assert.equal(noticeFor(pastDue, 'owner')!.state, 'past_due');
  assert.equal(noticeFor(pastDue, 'manager'), null);
  assert.equal(noticeFor(pastDue, 'staff'), null);
  assert.equal(noticeFor(readOnly, 'owner')!.state, 'read_only');
  for (const role of ['manager', 'staff'] as const) {
    const notice = noticeFor(readOnly, role)!;
    assert.deepEqual([notice.state, notice.readOnly], ['read_only', true]);
    assert.doesNotMatch(notice.detail, /\$|card|declined/i, 'staff are told what changed for them, not the Owner\'s payment details');
  }
});

// ---- the Owner's emails

const notice: NoticeInput = {
  teamName: 'The Olive Room',
  timeZone: 'Africa/Lagos',
  owner: { email: 'owner@example.test', name: 'Olive Owner' },
  sender: { from: 'Rota <notification@rota.example>', replyTo: 'rota@example.test' },
  renewalId: randomUUID(),
  amountCents: 5000,
  failureCode: 'card_declined',
  graceEndsAt: new Date('2026-11-16T09:30:00.000Z'),
};

test('the "could not collect" email names the team, the amount, the reason, the day access ends and what to do, with the test-mode wording', () => {
  const mail = renderRenewalFailedEmail(notice);
  assert.equal(mail.subject, "Rota: we could not collect The Olive Room's renewal payment");
  for (const part of ['$50.00', 'Your card was declined.', 'until 16 November 2026 at 10:30 (Africa/Lagos)', 'Retry payment', 'This integration uses Stripe test mode only. Live-payment eligibility has not been verified.']) {
    assert.ok(mail.text.includes(part), `text: ${part}`);
  }
  assert.ok(mail.html.includes('$50.00'));
});

test('the "now read-only" email says what stops and what keeps working', () => {
  const mail = renderTeamReadOnlyEmail(notice);
  assert.equal(mail.subject, 'Rota: The Olive Room is now read-only');
  assert.match(mail.text, /Nobody can change shifts, swaps or invitations/);
  assert.match(mail.text, /still sign in/);
});

test('a team or person name with markup or a line break cannot break the subject or inject HTML', () => {
  const evil = { ...notice, teamName: 'Evil <script>alert(1)</script>\r\nBcc: x@example.test' };
  const mail = renderRenewalFailedEmail(evil);
  assert.doesNotMatch(mail.subject, /[\r\n]/);
  assert.doesNotMatch(mail.html, /<script>/);
});
