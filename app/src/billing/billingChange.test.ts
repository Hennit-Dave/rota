import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createBillingApi } from './billingApi';
import { describeBillingFailure } from './billingFailure';
import { parseChangeAnswer, parseChangeQuote, parseHistory, parseOperation, parseOverview } from './billingResponses';
import { seatsFrom } from './seatsInput';

const TEAM = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';

const quoteBody = (over: Record<string, unknown> = {}) => ({
  quote: {
    effect: 'after_payment',
    supported: true,
    current: { plan: 'team', planName: 'Team', seats: 15 },
    applyNow: { plan: 'team', planName: 'Team', seats: 18 },
    atPeriodEnd: null,
    chargeTodayDisplay: '$3.60',
    nextRenewalDisplay: '$59.00',
    remainingDays: 12,
    periodEndsOn: '2031-07-01',
    headline: 'You’ll be charged $3.60 today for the 12 days left in this period. Your change starts once the payment is confirmed.',
    testModeNotice: 'This integration uses Stripe test mode only. Live-payment eligibility has not been verified.',
    ...over,
  },
});
const operation = { id: '22222222-2222-4222-8222-222222222222', kind: 'change', status: 'awaiting_payment', plan: 'team', planName: 'Team', seats: 18, amountDisplay: '$3.60', expiresAt: '2031-06-19T10:31:00.000Z' };

test('a change quote is read field by field; the server\'s sentence and figures pass through untouched', () => {
  const q = parseChangeQuote(quoteBody());
  assert.equal(q.effect, 'after_payment');
  assert.equal(q.supported, true);
  assert.equal(q.chargeTodayDisplay, '$3.60');
  assert.equal(q.nextRenewalDisplay, '$59.00');
  assert.match(q.headline, /charged \$3\.60 today for the 12 days left/);
  const free = parseChangeQuote(quoteBody({ effect: 'now', chargeTodayDisplay: null }));
  assert.equal(free.chargeTodayDisplay, null);
  const later = parseChangeQuote(quoteBody({ effect: 'mixed', supported: false, atPeriodEnd: { plan: 'business', planName: 'Business', seats: 10 } }));
  assert.equal(later.atPeriodEnd?.seats, 10);
});

test('a quote, an answer or a history that cannot be read throws invalid_response', () => {
  const bad = (fn: () => unknown) => assert.throws(fn, (e) => e instanceof ApiError && e.code === 'invalid_response');
  bad(() => parseChangeQuote(null));
  bad(() => parseChangeQuote(quoteBody({ effect: 'someday' })));
  bad(() => parseChangeQuote(quoteBody({ supported: 'yes' })));
  bad(() => parseChangeQuote(quoteBody({ chargeTodayDisplay: 360 })));
  bad(() => parseChangeQuote(quoteBody({ current: { plan: 'gold', planName: 'Gold', seats: 1 } })));
  bad(() => parseChangeAnswer({ status: 'maybe' }));
  bad(() => parseChangeAnswer({ status: 'payment_required', operation, checkoutUrl: 'https://evil.example.com/pay' }));
  bad(() => parseHistory({ history: [{ id: 'x' }], hasMore: false }));
  bad(() => parseHistory({ history: [], hasMore: 'no' }));
});

test('the answer to "make this change" is either applied at once or a payment with Stripe\'s page, and nothing else', () => {
  const applied = parseChangeAnswer({
    status: 'applied',
    change: { plan: 'team', planName: 'Team', seats: 15, message: 'No charge today.', nextRenewalDisplay: '$50.00', periodEndsOn: '2031-07-01' },
  });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.status === 'applied' && applied.change.seats, 15);
  const paid = parseChangeAnswer({ status: 'payment_required', operation, checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  assert.equal(paid.status, 'payment_required');
  assert.equal(paid.status === 'payment_required' && paid.operation.kind, 'change');
});

test('an operation knows whether it is the first payment or a change, and the overview carries the open payment', () => {
  assert.equal(parseOperation(operation).kind, 'change');
  assert.equal(parseOperation({ ...operation, kind: undefined }).kind, 'activation', 'an older answer without a kind is the first payment');
  const overview = parseOverview({
    testModeNotice: 'Test mode.', activated: true, plans: [], members: 3, seatLimit: 15,
    subscription: { plan: 'team', planName: 'Team', seats: 15, monthlyDisplay: '$50.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01' },
    openOperation: operation,
  });
  assert.equal(overview.openOperation?.id, operation.id);
  assert.equal(parseOverview({ ...overview, subscription: overview.subscription, openOperation: null }).openOperation, null);
});

test('history entries are read with their lines; amounts stay the server\'s text', () => {
  const h = parseHistory({
    history: [
      { id: 'a', date: '2031-06-19', title: 'Plan or seats changed', detail: 'Team · 18 seats', netDisplay: '+$3.60', lines: [{ label: 'Credit', amountDisplay: '−$20.00' }, { label: 'Charge', amountDisplay: '+$23.60' }] },
      { id: 'b', date: '2031-06-01', title: 'Subscription activated', detail: null, netDisplay: '+$50.00', lines: [] },
    ],
    hasMore: false,
  });
  assert.equal(h.history.length, 2);
  assert.deepEqual(h.history[0]!.lines.map((l) => l.amountDisplay), ['−$20.00', '+$23.60']);
  assert.equal(h.history[1]!.detail, null);
});

test('change quote: GET carries only the plan and the seat count', async () => {
  const h = makeHarness({ handler: () => json(200, quoteBody()) });
  const q = await createBillingApi(h.client).changeQuote(TEAM, 'team', 18);
  assert.equal(q.chargeTodayDisplay, '$3.60');
  assert.equal(h.calls[0]?.method, 'GET');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/change-quote`);
  assert.equal(h.calls[0]?.search, '?plan=team&seats=18');
});

test('make a change: POST sends ONLY the plan and the seats, with the idempotency key as a header', async () => {
  const h = makeHarness({ handler: () => json(201, { status: 'payment_required', operation, checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' }) });
  const answer = await createBillingApi(h.client).startChange(TEAM, { plan: 'team', seats: 18 }, KEY);
  assert.equal(answer.status, 'payment_required');
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/changes`);
  assert.deepEqual(h.calls[0]?.body, { plan: 'team', seats: 18 }, 'never an amount, a price, a team or a user');
  assert.equal(h.calls[0]?.headers?.['idempotency-key'] ?? h.calls[0]?.headers?.['Idempotency-Key'], KEY);
});

test('history: GET /history', async () => {
  const h = makeHarness({ handler: () => json(200, { history: [], hasMore: false }) });
  assert.deepEqual(await createBillingApi(h.client).history(TEAM), { history: [], hasMore: false });
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/history`);
});

test('the new refusals become words from the server\'s code: a payment open, the period ended or ending, no subscription, reductions later', () => {
  const api = (status: number, code: string) => new ApiError(status, code, 'x', 'req-7', undefined, null);
  for (const code of ['payment_in_progress', 'period_ended', 'period_ending', 'not_activated', 'scheduled_change_unavailable']) {
    const f = describeBillingFailure(api(409, code));
    assert.equal(f?.kind, 'banner', code);
    assert.ok((f as { message: string }).message.length > 10, code);
  }
  assert.match((describeBillingFailure(api(409, 'period_ending')) as { message: string }).message, /renewal/i);
});

test('seats are read from the field as a whole number of seats, and nothing else', () => {
  assert.equal(seatsFrom('18'), 18);
  assert.equal(seatsFrom('00007'), 7);
  for (const bad of ['', '0', '-1', '1.5', 'abc', '123456', ' 5']) assert.equal(seatsFrom(bad), null, JSON.stringify(bad));
});
