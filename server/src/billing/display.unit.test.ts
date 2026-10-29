import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIRST_PERIOD_NOTE, formatUsd, planOptions, TEST_MODE_NOTICE } from './display.js';

test('formatUsd turns whole cents into dollars with integer arithmetic only', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(5), '$0.05');
  assert.equal(formatUsd(50), '$0.50');
  assert.equal(formatUsd(360), '$3.60');
  assert.equal(formatUsd(2000), '$20.00');
  assert.equal(formatUsd(4667), '$46.67');
  assert.equal(formatUsd(14000), '$140.00');
  assert.equal(formatUsd(99_999_999), '$999999.99');
});

test('formatUsd refuses a value that is not a non-negative whole number of cents', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) assert.throws(() => formatUsd(bad), /integer number of cents/);
});

test('the plans the app is offered carry finished strings: the app holds no price', () => {
  assert.deepEqual(planOptions(), [
    { id: 'starter', name: 'Starter', priceDisplay: '$20.00', includedSeats: 5, extraSeatDisplay: null },
    { id: 'team', name: 'Team', priceDisplay: '$50.00', includedSeats: 15, extraSeatDisplay: '$3.00' },
    { id: 'business', name: 'Business', priceDisplay: '$120.00', includedSeats: 40, extraSeatDisplay: '$2.00' },
  ]);
});

test('the test-mode wording is the required sentence, and the first-period note says it is charged in full', () => {
  assert.equal(TEST_MODE_NOTICE, 'This integration uses Stripe test mode only. Live-payment eligibility has not been verified.');
  assert.match(FIRST_PERIOD_NOTE, /charged in full/);
});
