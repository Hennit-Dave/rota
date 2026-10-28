import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monthlyCents, type Entitlements } from './plans.js';
import { proratedCents, quoteChange, type ChangeQuote } from './proration.js';

// Acceptance cases from .agents/rules/money.md (brief: at least 8; 30-day fixtures unless stated). Expected values are the rule's, not ours to adjust.
const starter = (seats: number): Entitlements => ({ plan: 'starter', seats });
const team = (seats: number): Entitlements => ({ plan: 'team', seats });
const business = (seats: number): Entitlements => ({ plan: 'business', seats });

/** A change in a period of `periodDays` with `remainingDays` left, paid at the current entitlements' amount unless `paidBasis` says otherwise. */
function change(current: Entitlements, target: Entitlements, remainingDays: number, opts: { periodDays?: number; paidBasis?: number } = {}): ChangeQuote {
  return quoteChange({ current, target, paidBasisCents: opts.paidBasis ?? monthlyCents(current), periodDays: opts.periodDays ?? 30, remainingDays });
}

test('monthly amount: price plus extra seats beyond the allowance', () => {
  assert.equal(monthlyCents(starter(5)), 2000);
  assert.equal(monthlyCents(team(15)), 5000);
  assert.equal(monthlyCents(team(18)), 5900);
  assert.equal(monthlyCents(team(50)), 15500);
  assert.equal(monthlyCents(business(40)), 12000);
  assert.equal(monthlyCents(business(50)), 14000);
  assert.throws(() => monthlyCents(starter(6)), /seats_over_plan_limit/, 'Starter never exceeds 5');
  assert.throws(() => monthlyCents(team(0)), /positive_integer/);
  assert.throws(() => monthlyCents(team(1.5)), /positive_integer/);
});

test('1. upgrade (the brief): Starter 5 to Team 9 with 20 of 30 days left is 2000, after payment', () => {
  const q = change(starter(5), team(9), 20);
  assert.equal(q.kind, 'paid');
  assert.equal(q.chargeCents, 2000);
  assert.deepEqual(q.calculation, { newMonthlyCents: 5000, paidBasisCents: 2000, remainingDays: 20, periodDays: 30, grossChargeCents: 3333, creditCents: 1333 });
  assert.deepEqual(q.applyNow, team(9));
  assert.equal(q.atPeriodEnd, null);
  assert.equal(q.paidBasisAfterCents, 5000);
  assert.equal(q.nextRenewalCents, 5000, 'next period: 5000');
});

test('2. downgrade: Team to Starter is 0 now and Starter from the next period', () => {
  const q = change(team(5), starter(5), 20);
  assert.equal(q.kind, 'scheduled_only');
  assert.equal(q.chargeCents, 0);
  assert.deepEqual(q.applyNow, team(5), 'nothing changes now');
  assert.deepEqual(q.atPeriodEnd, starter(5));
  assert.equal(q.paidBasisAfterCents, 5000, 'the period stays paid at what was paid; no refund');
  assert.equal(q.nextRenewalCents, 2000);
});

test('3. seats inside the allowance: Team 12 to 15 with 12 days left is 0 and applies immediately', () => {
  const q = change(team(12), team(15), 12);
  assert.equal(q.kind, 'immediate');
  assert.equal(q.chargeCents, 0);
  assert.deepEqual(q.applyNow, team(15));
  assert.equal(q.paidBasisAfterCents, 5000, 'paid_basis unchanged');
  assert.equal(q.calculation, null);
});

test('4. remove seats: Team 18 to 15 is 0 now and 15 from the next period (even though it is cheaper later, nothing is refunded)', () => {
  const q = change(team(18), team(15), 20);
  assert.equal(q.kind, 'scheduled_only');
  assert.equal(q.chargeCents, 0);
  assert.deepEqual(q.applyNow, team(18));
  assert.deepEqual(q.atPeriodEnd, team(15));
  assert.equal(q.paidBasisAfterCents, 5900);
  assert.equal(q.nextRenewalCents, 5000);
});

test('5. first day: Starter 5 to Team 9 with all 30 days left is 3000', () => {
  assert.equal(change(starter(5), team(9), 30).chargeCents, 3000);
});

test('6. last day: Starter 5 to Team 9 with 1 day left is 100 (166 minus 66; each term rounds down separately)', () => {
  const q = change(starter(5), team(9), 1);
  assert.equal(q.chargeCents, 100);
  assert.equal(q.calculation?.grossChargeCents, 166);
  assert.equal(q.calculation?.creditCents, 66);
});

test('7. two changes in one period: day 11 then day 21 give 2000 then 2334 (the second is priced from the new paid basis)', () => {
  const first = change(starter(5), team(9), 20);
  assert.equal(first.chargeCents, 2000);
  const second = quoteChange({ current: first.applyNow, target: business(9), paidBasisCents: first.paidBasisAfterCents, periodDays: 30, remainingDays: 10 });
  assert.equal(second.kind, 'paid');
  assert.equal(second.chargeCents, 2334);
  assert.equal(second.calculation?.grossChargeCents, 4000);
  assert.equal(second.calculation?.creditCents, 1666);
  assert.equal(second.paidBasisAfterCents, 12000);
});

test('8. seats beyond the allowance: Team 15 to 18 with 12 days left is 360', () => {
  const q = change(team(15), team(18), 12);
  assert.equal(q.kind, 'paid');
  assert.equal(q.chargeCents, 360);
  assert.equal(q.paidBasisAfterCents, 5900);
});

test('Figma billing frame: Team to Business with 20 days left is 4667', () => {
  assert.equal(change(team(9), business(9), 20).chargeCents, 4667);
});

test('a 31-day period uses 31, not 30 (1935, where a hard-coded 30 would give 2000)', () => {
  const q = change(starter(5), team(9), 20, { periodDays: 31 });
  assert.equal(q.chargeCents, 1935);
  assert.equal(q.calculation?.periodDays, 31);
});

test('a 28-day period uses 28: 14 days left is 1500', () => {
  assert.equal(change(starter(5), team(9), 14, { periodDays: 28 }).chargeCents, 1500);
});

test('Team 50 to Business 50 is a cheaper upgrade: immediate, 0, paid_basis stays 15500, 14000 from renewal; then 55 seats is still inside what was paid; 60 seats charges 167', () => {
  const up = change(team(50), business(50), 10);
  assert.equal(up.kind, 'immediate');
  assert.equal(up.chargeCents, 0);
  assert.deepEqual(up.applyNow, business(50));
  assert.equal(up.paidBasisAfterCents, 15500);
  assert.equal(up.nextRenewalCents, 14000);

  const fiftyFive = quoteChange({ current: business(50), target: business(55), paidBasisCents: 15500, periodDays: 30, remainingDays: 10 });
  assert.equal(monthlyCents(business(55)), 15000);
  assert.equal(fiftyFive.kind, 'immediate', '15000 is not above the paid basis of 15500');
  assert.equal(fiftyFive.chargeCents, 0);
  assert.equal(fiftyFive.paidBasisAfterCents, 15500);

  const sixty = quoteChange({ current: business(55), target: business(60), paidBasisCents: 15500, periodDays: 30, remainingDays: 10 });
  assert.equal(monthlyCents(business(60)), 16000);
  assert.equal(sixty.kind, 'paid');
  assert.equal(sixty.chargeCents, 167, 'floor(16000 x 10 / 30) - floor(15500 x 10 / 30) = 5333 - 5166');
  assert.equal(sixty.paidBasisAfterCents, 16000);
});

test('a mixed change splits: Team 18 to Business 10 raises the tier now (charged on the increase only) and cuts the seats at period end', () => {
  const q = change(team(18), business(10), 20);
  assert.equal(q.kind, 'paid');
  assert.deepEqual(q.applyNow, business(18), 'higher tier now, seats unchanged');
  assert.deepEqual(q.atPeriodEnd, business(10));
  assert.equal(q.calculation?.newMonthlyCents, 12000);
  assert.equal(q.calculation?.paidBasisCents, 5900, 'the old side is what was PAID, not an entitlement amount');
  assert.equal(q.chargeCents, 4067, 'floor(12000 x 20 / 30) - floor(5900 x 20 / 30) = 8000 - 3933');
  assert.equal(q.nextRenewalCents, 12000);
});

test('a mixed change the other way: a lower tier with more seats raises the seats now and the tier at period end', () => {
  const q = change(business(3), team(20), 12);
  assert.deepEqual(q.applyNow, business(20), 'seats now, tier later');
  assert.deepEqual(q.atPeriodEnd, team(20));
  assert.equal(q.kind, 'immediate', 'Business 20 costs 12000, the same as the amount already paid');
  assert.equal(q.chargeCents, 0);
  assert.equal(q.nextRenewalCents, 6500);
});

test('a mixed change whose immediate part is free still schedules the rest', () => {
  const q = change(team(50), business(40), 12);
  assert.equal(q.kind, 'immediate');
  assert.deepEqual(q.applyNow, business(50));
  assert.deepEqual(q.atPeriodEnd, business(40));
  assert.equal(q.chargeCents, 0);
  assert.equal(q.nextRenewalCents, 12000);
});

test('asking for what the team already has changes nothing', () => {
  const q = change(team(9), team(9), 20);
  assert.equal(q.kind, 'none');
  assert.equal(q.chargeCents, 0);
  assert.equal(q.atPeriodEnd, null);
});

test('the quote reads the paid basis it is given: a team paid at a higher amount than its entitlements pays less', () => {
  const q = change(team(9), business(9), 20, { paidBasis: 6000 });
  assert.equal(q.chargeCents, 8000 - 4000);
});

test('exact integer arithmetic: the multiply happens before the divide and never loses precision', () => {
  assert.equal(proratedCents(2000, 20, 30), 1333);
  assert.equal(proratedCents(5000, 20, 30), 3333);
  assert.equal(proratedCents(Number.MAX_SAFE_INTEGER, 31, 31), Number.MAX_SAFE_INTEGER, 'above 2^53 a float product would be wrong');
  assert.equal(proratedCents(0, 5, 30), 0);
});

test('bad inputs are refused instead of guessed at', () => {
  assert.throws(() => proratedCents(-1, 1, 30), /non-negative/);
  assert.throws(() => proratedCents(10.5, 1, 30), /non-negative integer/);
  assert.throws(() => proratedCents(100, 0, 30), /remaining/);
  assert.throws(() => proratedCents(100, 31, 30), /remaining/);
  assert.throws(() => proratedCents(100, 5, 27), /28 to 31/);
  assert.throws(() => proratedCents(100, 5, 32), /28 to 31/);
  assert.throws(() => change(starter(5), starter(6), 10), /seats_over_plan_limit/);
});
