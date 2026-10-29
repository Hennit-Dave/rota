import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createBillingApi } from './billingApi';
import { describeBillingFailure } from './billingFailure';
import { isSettled, isStripeCheckoutUrl, parseOperationResponse, parseOverview, parseQuote, parseStartResponse, type OperationStatus } from './billingResponses';

const TEAM = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

const plans = [
  { id: 'starter', name: 'Starter', priceDisplay: '$20.00', includedSeats: 5, extraSeatDisplay: null },
  { id: 'team', name: 'Team', priceDisplay: '$50.00', includedSeats: 15, extraSeatDisplay: '$3.00' },
  { id: 'business', name: 'Business', priceDisplay: '$120.00', includedSeats: 40, extraSeatDisplay: '$2.00' },
];
const overviewBody = (over: Record<string, unknown> = {}) => ({
  testModeNotice: 'This integration uses Stripe test mode only. Live-payment eligibility has not been verified.',
  activated: false,
  plans,
  subscription: null,
  members: 2,
  seatLimit: 5,
  ...over,
});
const operationBody = (over: Record<string, unknown> = {}) => ({
  id: OP, kind: 'activation', status: 'awaiting_payment', plan: 'team', planName: 'Team', seats: 9, amountDisplay: '$50.00', expiresAt: '2031-06-01T12:31:00.000Z', ...over,
});
const quoteBody = {
  quote: { plan: 'team', planName: 'Team', seats: 9, chargeTodayDisplay: '$50.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01', note: 'Charged in full.', testModeNotice: 'Test mode.' },
};

test('the overview is read field by field; finished strings pass through untouched and nothing is computed', () => {
  const o = parseOverview(overviewBody());
  assert.equal(o.activated, false);
  assert.deepEqual(o.plans.map((p) => [p.id, p.priceDisplay, p.extraSeatDisplay]), [['starter', '$20.00', null], ['team', '$50.00', '$3.00'], ['business', '$120.00', '$2.00']]);
  const active = parseOverview(overviewBody({ activated: true, subscription: { plan: 'team', planName: 'Team', seats: 9, monthlyDisplay: '$50.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01' } }));
  assert.equal(active.subscription?.monthlyDisplay, '$50.00');
});

test('an overview, quote or operation that cannot be read throws invalid_response', () => {
  const bad = (fn: () => unknown) => assert.throws(fn, (e) => e instanceof ApiError && e.code === 'invalid_response');
  bad(() => parseOverview(null));
  bad(() => parseOverview(overviewBody({ plans: [{ id: 'gold' }] })));
  bad(() => parseOverview(overviewBody({ activated: true })), /* activated without a subscription is contradictory */);
  bad(() => parseOverview(overviewBody({ members: -1 })));
  bad(() => parseQuote({ quote: { ...quoteBody.quote, chargeTodayDisplay: 5000 } }));
  bad(() => parseQuote({}));
  bad(() => parseOperationResponse({ operation: operationBody({ status: 'paid_maybe' }) }));
  bad(() => parseOperationResponse({ operation: operationBody({ seats: 'nine' }) }));
  bad(() => parseOperationResponse({}));
  bad(() => parseStartResponse({ operation: operationBody(), checkoutUrl: 'https://evil.example.com/pay' }));
});

test('only an https address on stripe.com is ever opened as the payment page', () => {
  assert.equal(isStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_1'), true);
  for (const bad of ['http://checkout.stripe.com/c/pay/cs_1', 'https://checkout.stripe.com.evil.example/c', 'https://evilstripe.com/c', 'javascript:alert(1)', 'rota://billing', '', null, 5]) {
    assert.equal(isStripeCheckoutUrl(bad), false, String(bad));
  }
});

test('only paid, failed, expired and under_review are settled: waiting and confirming keep the screen asking the server', () => {
  const all: OperationStatus[] = ['awaiting_payment', 'confirming', 'paid', 'failed', 'expired', 'under_review'];
  assert.deepEqual(all.filter(isSettled), ['paid', 'failed', 'expired', 'under_review']);
});

test('quote: GET carries only the plan and the seat count; the answer is the server\'s finished text', async () => {
  const h = makeHarness({ handler: () => json(200, quoteBody) });
  const q = await createBillingApi(h.client).quote(TEAM, 'team', 9);
  assert.equal(q.chargeTodayDisplay, '$50.00');
  assert.equal(h.calls[0]?.method, 'GET');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/activation-quote`);
  assert.equal(h.calls[0]?.search, '?plan=team&seats=9');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('start: POST sends ONLY the plan and the seats, with the idempotency key as a header: never an amount, a price, a team or a user', async () => {
  const h = makeHarness({ handler: () => json(201, { operation: operationBody(), checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' }) });
  const started = await createBillingApi(h.client).startActivation(TEAM, { plan: 'team', seats: 9 }, KEY);
  assert.equal(started.operation.status, 'awaiting_payment');
  assert.equal(started.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/activation`);
  assert.deepEqual(h.calls[0]?.body, { plan: 'team', seats: 9 });
  assert.equal(h.calls[0]?.headers?.['idempotency-key'] ?? h.calls[0]?.headers?.['Idempotency-Key'], KEY);
});

test('operation and cancel: the status is whatever the server says', async () => {
  const h = makeHarness({ handler: (c) => json(200, { operation: operationBody({ status: c.path.endsWith('/cancel') ? 'expired' : 'confirming' }) }) });
  const api = createBillingApi(h.client);
  assert.equal((await api.operation(TEAM, OP)).status, 'confirming');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/operations/${OP}`);
  assert.equal((await api.cancel(TEAM, OP)).status, 'expired');
  assert.equal(h.calls[1]?.method, 'POST');
  assert.equal(h.calls[1]?.path, `/teams/${TEAM}/billing/operations/${OP}/cancel`);
});

test('a failed billing call becomes words only from the server\'s code', () => {
  const api = (status: number, code: string, extra: Partial<{ retry: number | null }> = {}) => new ApiError(status, code, 'x', 'req-7', undefined, extra.retry ?? null);
  assert.equal(describeBillingFailure(new StaleAccountError() as unknown), null);
  assert.equal(describeBillingFailure(new SessionEndedError('refresh_rejected')), null);
  assert.equal(describeBillingFailure(new NotSignedInError()), null);
  assert.deepEqual(describeBillingFailure(new OfflineError()), { kind: 'offline' });
  assert.deepEqual(describeBillingFailure(api(404, 'not_found')), { kind: 'gone' });
  assert.deepEqual(describeBillingFailure(api(503, 'service_unavailable')), { kind: 'unavailable' });
  assert.equal(describeBillingFailure(api(409, 'payment_in_progress'))?.kind, 'banner');
  assert.equal(describeBillingFailure(api(409, 'already_activated'))?.kind, 'banner');
  assert.equal(describeBillingFailure(api(422, 'seats_below_members'))?.kind, 'banner');
  assert.equal(describeBillingFailure(api(403, 'forbidden'))?.kind, 'banner');
  assert.equal(describeBillingFailure(api(429, 'rate_limited', { retry: 1800 }))?.kind, 'rate_limited');
  assert.deepEqual(describeBillingFailure(api(500, 'internal_error')), { kind: 'generic', reference: 'req-7' });
  assert.deepEqual(describeBillingFailure(new Error('boom')), { kind: 'generic', reference: null });
});

test('NO MONEY LOGIC IN THE APP: no price, no arithmetic on an amount, no division by 100 anywhere in the billing code or its screens', () => {
  const files: string[] = [];
  const add = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) add(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(path);
    }
  };
  add(join(__dirname));
  add(join(__dirname, '..', 'app', '(app)', 'billing'));
  add(join(__dirname, '..', 'app', 'checkout'));
  assert.ok(files.length >= 8, `found the billing files (${files.length})`);
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.ok(!/\b(2000|5000|12000)\b/.test(code), `${file}: a plan price in the app`);
    assert.ok(!/(amount|price|total|cents|charge)\w*\s*[-+*/%]\s*\w/i.test(code), `${file}: arithmetic on an amount`);
    assert.ok(!/[/*]\s*100\b/.test(code), `${file}: dividing or multiplying by 100`);
    assert.ok(!/toFixed\(|parseFloat|Intl\.NumberFormat/.test(code), `${file}: formatting a number as money`);
  }
});
