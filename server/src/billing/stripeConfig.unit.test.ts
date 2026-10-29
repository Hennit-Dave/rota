import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStripeConfig } from './stripeConfig.js';

const good = { STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' };

test('a test key and a whsec_ secret load, with the 10 second default timeout', () => {
  assert.deepEqual(loadStripeConfig(good), { secretKey: 'sk_test_abc123', webhookSecret: 'whsec_abc123', timeoutMs: 10_000 });
  assert.equal(loadStripeConfig({ ...good, STRIPE_TIMEOUT_MS: '2500' }).timeoutMs, 2500);
});

test('LIVE MODE IS REFUSED: any key that is not sk_test_ stops the API, and the message never contains the key', () => {
  for (const live of ['sk_live_SECRETVALUE', 'rk_live_SECRETVALUE', 'rk_test_SECRETVALUE', 'pk_test_SECRETVALUE', 'SECRETVALUE', 'SK_TEST_SECRETVALUE']) {
    assert.throws(
      () => loadStripeConfig({ ...good, STRIPE_SECRET_KEY: live }),
      (err: Error) => /must be a Stripe TEST key/.test(err.message) && !err.message.includes('SECRETVALUE'),
      live.slice(0, 8),
    );
  }
});

test('missing or malformed values stop the API, naming the variable and never the value', () => {
  assert.throws(() => loadStripeConfig({ STRIPE_WEBHOOK_SECRET: 'whsec_x' }), /STRIPE_SECRET_KEY is not set/);
  assert.throws(() => loadStripeConfig({ STRIPE_SECRET_KEY: '   ', STRIPE_WEBHOOK_SECRET: 'whsec_x' }), /STRIPE_SECRET_KEY is not set/);
  assert.throws(() => loadStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }), /STRIPE_WEBHOOK_SECRET is not set/);
  assert.throws(
    () => loadStripeConfig({ ...good, STRIPE_WEBHOOK_SECRET: 'sk_test_LEAKME' }),
    (err: Error) => /must start with whsec_/.test(err.message) && !err.message.includes('LEAKME'),
  );
  for (const bad of ['0', '-5', '1.5', 'abc']) assert.throws(() => loadStripeConfig({ ...good, STRIPE_TIMEOUT_MS: bad }), /STRIPE_TIMEOUT_MS/);
});
