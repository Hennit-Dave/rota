import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeChange, PAID_CHANGE_CUTOFF_MS } from './changes.js';
import { OPERATION_LIFETIME_MS } from './checkout.js';
import { formatSignedUsd } from './display.js';
import type { Entitlements } from './plans.js';
import { quoteChange } from './proration.js';

/** The engine's answer (money.md's cases), put into words by the server. The numbers in every sentence come from the engine. */
const words = (current: Entitlements, target: Entitlements, paidBasisCents: number, remaining: number, periodDays = 30) => {
  const quote = quoteChange({ current, target, paidBasisCents, periodDays, remainingDays: remaining });
  return { quote, ...describeChange({ quote, paidBasisCents, remaining }) };
};
const team = (seats: number): Entitlements => ({ plan: 'team', seats });
const starter = (seats: number): Entitlements => ({ plan: 'starter', seats });
const business = (seats: number): Entitlements => ({ plan: 'business', seats });

test('a paid increase says what is charged today, for how many days, and that it starts after the payment: Team 15 to 18 with 12 days left is $3.60', () => {
  const w = words(team(15), team(18), 5000, 12);
  assert.equal(w.quote.chargeCents, 360);
  assert.equal(w.effect, 'after_payment');
  assert.equal(w.supported, true);
  assert.equal(w.headline, 'You’ll be charged $3.60 today for the 12 days left in this period. Your change starts once the payment is confirmed.');
});

test('one day left reads "1 day"; the brief\'s upgrade, Starter 5 to Team 9 with 20 days left, is $20.00', () => {
  assert.match(words(starter(5), team(9), 2000, 1).headline, /charged \$1\.00 today for the 1 day left/);
  assert.match(words(starter(5), team(9), 2000, 20).headline, /charged \$20\.00 today for the 20 days left/);
});

test('seats inside the allowance, and a cheaper upgrade, apply now with no charge and the new amount from renewal', () => {
  for (const w of [words(team(12), team(15), 5000, 12), words(team(50), business(50), 15500, 10), words(business(50), business(55), 15500, 10)]) {
    assert.equal(w.effect, 'now');
    assert.equal(w.supported, true);
    assert.equal(w.quote.chargeCents, 0);
    assert.equal(w.headline, 'No charge today. Your change starts now and the new monthly amount applies from your next renewal.');
  }
});

test('UNDER STRIPE\'S MINIMUM: 10 and 40 cents apply now, free, and say why; exactly 50 cents is paid', () => {
  const one = words(team(15), team(16), 5000, 1);
  assert.equal(one.quote.kind, 'immediate');
  assert.equal(one.effect, 'now');
  assert.match(one.headline, /costs less than Stripe’s \$0\.50 minimum, so it starts now at no charge/);
  assert.equal(words(team(15), team(16), 5000, 4).quote.kind, 'immediate', '40 cents');
  const five = words(team(15), team(16), 5000, 5);
  assert.equal(five.quote.kind, 'paid');
  assert.equal(five.quote.chargeCents, 50);
  assert.match(five.headline, /charged \$0\.50 today/);
});

test('the money.md chain: 55 to 60 seats on Business, 10 days left, is $1.67 against a paid basis of $155.00', () => {
  const w = words(business(55), business(60), 15500, 10);
  assert.equal(w.quote.chargeCents, 167);
  assert.match(w.headline, /charged \$1\.67 today for the 10 days left/);
});

test('a pure decrease is offered as a reduction at period end: nothing now, the date, the next renewal, and how many people must be chosen', () => {
  const quote = quoteChange({ current: team(18), target: team(15), paidBasisCents: 5900, periodDays: 30, remainingDays: 12 });
  const down = describeChange({ quote, paidBasisCents: 5900, remaining: 12, reduction: { effectiveOn: '2026-11-11', membersToDeactivate: 2 } });
  assert.equal(down.effect, 'at_period_end');
  assert.equal(down.supported, true);
  assert.match(down.headline, /takes effect at the end of your period, on 2026-11-11\. Nothing is charged or refunded now/);
  assert.match(down.headline, /2 people will become inactive on that date, and you choose who\./);
  const fits = describeChange({ quote, paidBasisCents: 5900, remaining: 12, reduction: { effectiveOn: '2026-11-11', membersToDeactivate: 0 } });
  assert.doesNotMatch(fits.headline, /become inactive/);
  const one = describeChange({ quote, paidBasisCents: 5900, remaining: 12, reduction: { effectiveOn: '2026-11-11', membersToDeactivate: 1 } });
  assert.match(one.headline, /1 person will become inactive/);
});

test('a mixed change (increase now, decrease later) and "nothing" are not offered: the quote says so in words and supported is false', () => {
  const mixed = words(team(18), business(10), 5900, 12);
  assert.equal(mixed.effect, 'mixed');
  assert.equal(mixed.supported, false);
  assert.match(mixed.headline, /Make the increase first, then schedule the reduction/);
  const same = words(team(15), team(15), 5000, 12);
  assert.equal(same.effect, 'none');
  assert.equal(same.supported, false);
});

test('a paid change is refused in the last stretch of a period: exactly the lifetime of a payment operation, so none can outlive its period', () => {
  assert.equal(PAID_CHANGE_CUTOFF_MS, OPERATION_LIFETIME_MS);
  assert.equal(PAID_CHANGE_CUTOFF_MS, 31 * 60 * 1000);
});

test('history amounts carry their sign with whole-cent arithmetic only', () => {
  assert.equal(formatSignedUsd(360), '+$3.60');
  assert.equal(formatSignedUsd(-2000), '−$20.00');
  assert.equal(formatSignedUsd(5), '+$0.05');
  assert.equal(formatSignedUsd(0), '$0.00');
  assert.throws(() => formatSignedUsd(1.5), /whole number of cents/);
});
