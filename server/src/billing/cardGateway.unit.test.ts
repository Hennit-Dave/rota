import assert from 'node:assert/strict';
import { test } from 'node:test';
import Stripe from 'stripe';
import { createStripeGateway, setupIdempotencyKey, StripeRejectedError, StripeUncertainError, WebhookSignatureError, type CheckoutRequest, type SetupRequest } from './gateway.js';
import { loadStripeApiConfig } from './stripeConfig.js';
import { checkoutEventBody, signedHeaders } from './stripe.testkit.js';

// The Stripe requests for saving a card (ADR 0030). A real SDK object whose only network calls are replaced: the SDK's own code runs the rest.
const config = { secretKey: 'sk_test_unused_no_network_in_tests', timeoutMs: 1000 };
const consentText = 'By paying, you authorise Rota to charge this card the monthly price of your plan and seats, currently $50.00, on day 15 of each month until you remove this card. Test mode only.';
const payment: CheckoutRequest = {
  operationId: '11111111-1111-4111-8111-111111111111',
  teamId: '22222222-2222-4222-8222-222222222222',
  amountCents: 5000,
  productName: 'Rota Team plan, 9 seats',
  successUrl: 'https://rota.davebuilds.design/checkout/return?operation=11111111-1111-4111-8111-111111111111',
  cancelUrl: 'https://rota.davebuilds.design/checkout/cancel?operation=11111111-1111-4111-8111-111111111111',
  expiresAt: new Date('2031-06-01T12:31:00.000Z'),
};
const setup: SetupRequest = {
  setupId: '33333333-3333-4333-8333-333333333333',
  teamId: payment.teamId,
  successUrl: 'https://rota.davebuilds.design/checkout/card-return?setup=33333333-3333-4333-8333-333333333333',
  cancelUrl: 'https://rota.davebuilds.design/checkout/card-cancel?setup=33333333-3333-4333-8333-333333333333',
  expiresAt: new Date('2031-06-01T12:31:00.000Z'),
  saveCard: { consentText, customerId: null },
};

function clientWith(create: (params: any, options: any) => Promise<unknown>): Stripe {
  const client = new Stripe(config.secretKey);
  (client.checkout.sessions as any).create = create;
  return client;
}
const liveFalse = (id: string) => ({ id, url: `https://checkout.stripe.test/${id}`, livemode: false });

test('an activation that saves the card: setup_future_usage off_session, the wording beside the pay button, and Checkout creates the Customer when the team has none', async () => {
  let seen: any;
  const gateway = createStripeGateway(config, clientWith(async (params, options) => ((seen = { params, options }), liveFalse('cs_test_1'))));
  await gateway.createCheckoutSession({ ...payment, saveCard: { consentText, customerId: null } });
  assert.equal(seen.params.mode, 'payment', 'still a one-time payment: never a Stripe Subscription');
  assert.equal(seen.params.payment_intent_data.setup_future_usage, 'off_session');
  assert.deepEqual(seen.params.custom_text, { submit: { message: consentText } });
  assert.equal(seen.params.customer_creation, 'always', 'Checkout makes the Customer: no second synchronous Stripe call of ours');
  assert.equal('customer' in seen.params, false);
  assert.deepEqual(seen.params.payment_intent_data.metadata, { team_id: payment.teamId, operation_id: payment.operationId });
  assert.equal(seen.options.idempotencyKey, `op-${payment.operationId}`);
});

test('a team that already has a Stripe Customer passes it instead of making another', async () => {
  let seen: any;
  const gateway = createStripeGateway(config, clientWith(async (params) => ((seen = params), liveFalse('cs_test_1'))));
  await gateway.createCheckoutSession({ ...payment, saveCard: { consentText, customerId: 'cus_test_known' } });
  assert.equal(seen.customer, 'cus_test_known');
  assert.equal('customer_creation' in seen, false);
});

test('CARDS ONLY: both Checkout modes ask for allowed_payment_method_types ["card"], which removes Cash App Pay and Amazon Pay (the Stripe page still shows the Link button and a Bank row: ADR 0030, choice 9)', async () => {
  const seen: any[] = [];
  const gateway = createStripeGateway(config, clientWith(async (params) => (seen.push(params), liveFalse('cs_test_1'))));
  await gateway.createCheckoutSession({ ...payment, saveCard: { consentText, customerId: null } }); // activation
  await gateway.createCheckoutSession(payment); // a paid change
  await gateway.createSetupSession(setup); // add or replace a card
  assert.deepEqual(seen.map((p) => p.mode), ['payment', 'payment', 'setup']);
  for (const p of seen) assert.deepEqual(p.allowed_payment_method_types, ['card'], p.mode);
});

test('a PAID CHANGE saves nothing: no setup_future_usage, no custom text, no customer parameters (apart from cards only, the payment path of P4 is unchanged)', async () => {
  let seen: any;
  const gateway = createStripeGateway(config, clientWith(async (params) => ((seen = params), liveFalse('cs_test_1'))));
  await gateway.createCheckoutSession(payment);
  assert.equal('setup_future_usage' in seen.payment_intent_data, false);
  for (const key of ['custom_text', 'customer', 'customer_creation']) assert.equal(key in seen, false, key);
});

test('the setup-mode request: mode setup, usd, no line items, our ids on the Session AND the SetupIntent, a stable per-setup key', async () => {
  let seen: any;
  const gateway = createStripeGateway(config, clientWith(async (params, options) => ((seen = { params, options }), liveFalse('cs_test_9'))));
  assert.deepEqual(await gateway.createSetupSession(setup), { id: 'cs_test_9', url: 'https://checkout.stripe.test/cs_test_9' });
  const { params, options } = seen;
  assert.equal(params.mode, 'setup');
  assert.equal(params.currency, 'usd');
  assert.equal('line_items' in params, false, 'nothing is charged');
  assert.deepEqual(params.metadata, { team_id: setup.teamId, card_setup_id: setup.setupId });
  assert.deepEqual(params.setup_intent_data.metadata, params.metadata, 'Session metadata is not documented as copied to the SetupIntent, so it is set on both');
  assert.deepEqual(params.custom_text, { submit: { message: consentText } });
  assert.equal(params.customer_creation, 'always');
  assert.equal(params.expires_at, Math.floor(setup.expiresAt.getTime() / 1000));
  assert.equal(options.idempotencyKey, `setup-${setup.setupId}`);
  assert.equal(options.idempotencyKey, setupIdempotencyKey(setup.setupId));
  assert.equal('subscription_data' in params, false);
});

test('setup sessions get the same sorting of Stripe errors, and a LIVE session is refused', async () => {
  const fail = (err: unknown) => createStripeGateway(config, clientWith(async () => { throw err; })).createSetupSession(setup);
  await assert.rejects(fail(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'bad' })), StripeRejectedError);
  await assert.rejects(fail(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'timeout' })), StripeUncertainError);
  const live = createStripeGateway(config, clientWith(async () => ({ id: 'cs_live_1', url: 'https://x', livemode: true })));
  await assert.rejects(live.createSetupSession(setup), (e: Error) => e instanceof StripeRejectedError && /live_mode_session/.test(e.message));
});

test('reading the card a SetupIntent saved: the expanded payment method becomes plain facts (brand, last four, expiry), nothing else of the card', async () => {
  const client = new Stripe(config.secretKey);
  let args: any[] = [];
  (client.setupIntents as any).retrieve = async (...a: any[]) => {
    args = a;
    return {
      id: 'seti_1', status: 'succeeded', livemode: false, usage: 'off_session', customer: 'cus_1', metadata: { team_id: 't', card_setup_id: 's' },
      payment_method: { id: 'pm_1', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2031, fingerprint: 'must-not-be-copied', funding: 'credit' } },
    };
  };
  const facts = await createStripeGateway(config, client).retrieveSetupIntentCard('seti_1');
  assert.deepEqual(args, ['seti_1', { expand: ['payment_method'] }]);
  assert.deepEqual(facts, {
    status: 'succeeded', livemode: false, customerId: 'cus_1', paymentMethodId: 'pm_1', methodType: 'card',
    card: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2031 }, metadata: { team_id: 't', card_setup_id: 's' }, usage: 'off_session',
  });
});

test('reading the card an activation payment saved uses the PaymentIntent, and its setup_future_usage is the "usage"', async () => {
  const client = new Stripe(config.secretKey);
  (client.paymentIntents as any).retrieve = async () => ({
    id: 'pi_1', status: 'succeeded', livemode: false, setup_future_usage: 'off_session', customer: { id: 'cus_2' }, metadata: {},
    payment_method: { id: 'pm_2', type: 'card', card: { brand: 'mastercard', last4: '4444', exp_month: 1, exp_year: 2032 } },
  });
  const facts = await createStripeGateway(config, client).retrievePaymentIntentCard('pi_1');
  assert.equal(facts.usage, 'off_session');
  assert.equal(facts.customerId, 'cus_2', 'an expanded customer object still yields the id');
  assert.equal(facts.paymentMethodId, 'pm_2');
});

test('an unexpanded payment method (just an id) has no card; a Stripe failure on a read is sorted like every other', async () => {
  const client = new Stripe(config.secretKey);
  (client.setupIntents as any).retrieve = async () => ({ id: 'seti_2', status: 'requires_payment_method', livemode: false, usage: 'off_session', customer: null, metadata: {}, payment_method: null });
  const facts = await createStripeGateway(config, client).retrieveSetupIntentCard('seti_2');
  assert.deepEqual([facts.paymentMethodId, facts.card, facts.customerId], [null, null, null]);

  const failing = (err: unknown) => {
    const c = new Stripe(config.secretKey);
    (c.setupIntents as any).retrieve = async () => { throw err; };
    return createStripeGateway(config, c).retrieveSetupIntentCard('seti_x');
  };
  await assert.rejects(failing(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'No such setupintent' })), StripeRejectedError);
  await assert.rejects(failing(new Stripe.errors.StripeAPIError({ type: 'api_error', message: '500' })), StripeUncertainError);
});

test('the WORKER gateway holds no webhook secret: it can read from Stripe but verifies no webhook', () => {
  const gateway = createStripeGateway(config);
  const body = checkoutEventBody({ sessionId: 'cs_test_1', amountTotal: 5000 });
  assert.throws(() => gateway.constructEvent(Buffer.from(body), signedHeaders(body)['stripe-signature']!), WebhookSignatureError);
});

test('loadStripeApiConfig (the worker): a test key only, no value in any message, no webhook secret needed', () => {
  assert.deepEqual(loadStripeApiConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' }), { secretKey: 'sk_test_abc', timeoutMs: 10_000 });
  assert.equal(loadStripeApiConfig({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_TIMEOUT_MS: '2500' }).timeoutMs, 2500);
  // A restricted key (rk_test_) is accepted too (issue: deploy-only restricted key): the worker holds the same key as the API.
  assert.equal(loadStripeApiConfig({ STRIPE_SECRET_KEY: 'rk_test_abc' }).secretKey, 'rk_test_abc');
  for (const env of [{}, { STRIPE_SECRET_KEY: '' }, { STRIPE_SECRET_KEY: 'sk_live_SECRETVALUE' }, { STRIPE_SECRET_KEY: 'rk_live_SECRETVALUE' }, { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TIMEOUT_MS: '0' }]) {
    assert.throws(() => loadStripeApiConfig(env), (e: Error) => !/SECRETVALUE/.test(e.message));
  }
});
