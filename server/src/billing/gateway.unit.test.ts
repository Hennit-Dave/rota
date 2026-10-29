import assert from 'node:assert/strict';
import { test } from 'node:test';
import Stripe from 'stripe';
import { checkoutIdempotencyKey, createStripeGateway, StripeRejectedError, StripeUncertainError, WebhookSignatureError, type CheckoutRequest } from './gateway.js';
import { checkoutEventBody, signedHeaders, TEST_WEBHOOK_SECRET } from './stripe.testkit.js';

const config = { secretKey: 'sk_test_unused_no_network_in_tests', webhookSecret: TEST_WEBHOOK_SECRET, timeoutMs: 1000 };
const request: CheckoutRequest = {
  operationId: '11111111-1111-4111-8111-111111111111',
  teamId: '22222222-2222-4222-8222-222222222222',
  amountCents: 5000,
  productName: 'Rota Team plan, 9 seats',
  successUrl: 'https://rota.davebuilds.design/checkout/return?operation=11111111-1111-4111-8111-111111111111',
  cancelUrl: 'https://rota.davebuilds.design/checkout/cancel?operation=11111111-1111-4111-8111-111111111111',
  expiresAt: new Date('2031-06-01T12:31:00.000Z'),
};

/** A real SDK object whose only network call is replaced: the rest (signature checking) is Stripe's own code. */
function clientWith(create: (params: any, options: any) => Promise<unknown>): Stripe {
  const client = new Stripe(config.secretKey);
  (client.checkout.sessions as any).create = create;
  return client;
}

test('the Checkout Session request: payment mode, integer cents, usd, our metadata twice, a stable per-operation idempotency key, no subscription', async () => {
  let seen: { params: any; options: any } | null = null;
  const gateway = createStripeGateway(config, clientWith(async (params, options) => {
    seen = { params, options };
    return { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1', livemode: false };
  }));
  assert.deepEqual(await gateway.createCheckoutSession(request), { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
  const { params, options } = seen!;
  assert.equal(params.mode, 'payment', 'a one-time payment: never a Stripe Subscription');
  assert.deepEqual(params.line_items, [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 5000, product_data: { name: 'Rota Team plan, 9 seats' } } }]);
  assert.ok(Number.isInteger(params.line_items[0].price_data.unit_amount));
  assert.deepEqual(params.metadata, { team_id: request.teamId, operation_id: request.operationId });
  assert.deepEqual(params.payment_intent_data.metadata, params.metadata);
  assert.equal(params.expires_at, Math.floor(request.expiresAt.getTime() / 1000));
  assert.equal(params.success_url, request.successUrl);
  assert.equal(options.idempotencyKey, `op-${request.operationId}`);
  assert.equal(options.idempotencyKey, checkoutIdempotencyKey(request.operationId));
  assert.equal('subscription_data' in params, false);
});

test('Stripe errors are sorted into "refused" (a retry cannot help) and "unknown" (retry with the same key)', async () => {
  const fail = (err: unknown) => createStripeGateway(config, clientWith(async () => { throw err; })).createCheckoutSession(request);
  await assert.rejects(fail(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'bad' })), StripeRejectedError);
  await assert.rejects(fail(new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: 'bad key' })), StripeRejectedError);
  await assert.rejects(fail(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'timeout' })), StripeUncertainError);
  await assert.rejects(fail(new Stripe.errors.StripeAPIError({ type: 'api_error', message: '500' })), StripeUncertainError);
  await assert.rejects(fail(new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: '429' })), StripeUncertainError);
  await assert.rejects(fail(new Error('something else')), StripeUncertainError);
});

test('a session from LIVE mode is refused outright, and a session with no URL is an unknown outcome', async () => {
  const live = createStripeGateway(config, clientWith(async () => ({ id: 'cs_live_1', url: 'https://x', livemode: true })));
  await assert.rejects(live.createCheckoutSession(request), (e: Error) => e instanceof StripeRejectedError && /live_mode_session/.test(e.message));
  const noUrl = createStripeGateway(config, clientWith(async () => ({ id: 'cs_test_2', url: null, livemode: false })));
  await assert.rejects(noUrl.createCheckoutSession(request), StripeUncertainError);
});

test('webhook signatures: a correctly signed raw body is accepted; every other case is one WebhookSignatureError that carries nothing from the body', () => {
  const gateway = createStripeGateway(config);
  const body = checkoutEventBody({ sessionId: 'cs_test_1', amountTotal: 5000 });
  const ok = gateway.constructEvent(Buffer.from(body), signedHeaders(body)['stripe-signature']!) as { type: string };
  assert.equal(ok.type, 'checkout.session.completed');

  const header = signedHeaders(body)['stripe-signature']!;
  const cases: Array<[string, Buffer, string]> = [
    ['a tampered body', Buffer.from(body.replace('5000', '1')), header],
    ['a signature made with another secret', Buffer.from(body), signedHeaders(body, 'whsec_someone_elses_secret')['stripe-signature']!],
    ['garbage in the header', Buffer.from(body), 'not-a-signature'],
    ['an empty header', Buffer.from(body), ''],
    ['an old timestamp (replay)', Buffer.from(body), new Stripe(config.secretKey).webhooks.generateTestHeaderString({ payload: body, secret: TEST_WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 })],
  ];
  for (const [label, raw, sig] of cases) {
    assert.throws(() => gateway.constructEvent(raw, sig), (e: Error) => e instanceof WebhookSignatureError && !e.message.includes('cs_test_1'), label);
  }
});
