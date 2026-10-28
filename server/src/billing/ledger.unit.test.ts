import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyQuoteToState, ledgerRowsForActivation, ledgerRowsForChange, netPaidCents, rebuildSubscription, type LedgerRow, type SubscriptionState } from './ledger.js';
import { monthlyCents, type Entitlements } from './plans.js';
import { quoteChange } from './proration.js';

const starter = (seats: number): Entitlements => ({ plan: 'starter', seats });
const team = (seats: number): Entitlements => ({ plan: 'team', seats });
const business = (seats: number): Entitlements => ({ plan: 'business', seats });

/** Activates, then applies each change in order, keeping the stored state the way a transaction would and the ledger the way it would be written. */
function run(first: Entitlements, steps: Array<{ to: Entitlements; remaining: number }>) {
  const periodId = randomUUID();
  const rows: LedgerRow[] = ledgerRowsForActivation({ operationId: randomUUID(), periodId, entitlements: first });
  let state: SubscriptionState = { plan: first.plan, seats: first.seats, paidBasisCents: monthlyCents(first), currentPeriodId: periodId, version: 1 };
  const quotes = [];
  for (const step of steps) {
    const quote = quoteChange({ current: { plan: state.plan, seats: state.seats }, target: step.to, paidBasisCents: state.paidBasisCents, periodDays: 30, remainingDays: step.remaining });
    rows.push(...ledgerRowsForChange({ operationId: randomUUID(), periodId, quote }));
    state = applyQuoteToState(state, quote);
    quotes.push(quote);
  }
  return { rows, state, quotes, periodId };
}

test('activation writes the period start and the full first-period charge', () => {
  const { rows, periodId } = run(starter(5), []);
  assert.deepEqual(
    rows.map((r) => [r.entryType, r.sequence, r.amountCents, r.paidBasisAfterCents]),
    [['period_start', 1, 0, 2000], ['charge', 1, 2000, null]],
  );
  assert.deepEqual(rebuildSubscription(rows), { plan: 'starter', seats: 5, paidBasisCents: 2000, currentPeriodId: periodId, version: 1 });
});

test("the brief's upgrade writes a credit, a charge and the entitlement change; their money sums to the payment", () => {
  const { rows } = run(starter(5), [{ to: team(9), remaining: 20 }]);
  const upgrade = rows.slice(2);
  assert.deepEqual(
    upgrade.map((r) => [r.entryType, r.amountCents, r.plan, r.seats, r.paidBasisAfterCents]),
    [['credit', -1333, null, null, null], ['charge', 3333, null, null, null], ['entitlement_change', 0, 'team', 9, 5000]],
  );
  assert.equal(netPaidCents(upgrade), 2000, 'credit + charge = the amount collected');
  assert.equal(netPaidCents(rows), 4000, 'the first period plus the upgrade');
});

test('rebuilding from the ledger matches the state kept by applying each change, over several sequences of changes', () => {
  const sequences: Array<[Entitlements, Array<{ to: Entitlements; remaining: number }>]> = [
    [starter(5), [{ to: team(9), remaining: 20 }, { to: business(9), remaining: 10 }]], // test 7
    [team(12), [{ to: team(15), remaining: 12 }, { to: team(18), remaining: 12 }]], // free, then paid
    [team(50), [{ to: business(50), remaining: 10 }, { to: business(55), remaining: 10 }, { to: business(60), remaining: 10 }]], // cheaper upgrade, growth, 167
    [team(18), [{ to: business(10), remaining: 20 }]], // mixed
    [team(18), [{ to: team(15), remaining: 20 }]], // scheduled only: no ledger rows
    [business(9), [{ to: business(9), remaining: 5 }]], // nothing to do
  ];
  for (const [first, steps] of sequences) {
    const { rows, state } = run(first, steps);
    assert.deepEqual(rebuildSubscription(rows), state, `${first.plan} ${first.seats} then ${steps.map((s) => `${s.to.plan} ${s.to.seats}`).join(', ')}`);
  }
});

test('a free immediate change writes only its entitlement change and leaves paid_basis alone', () => {
  const { rows, state } = run(team(50), [{ to: business(50), remaining: 10 }]);
  const change = rows.slice(2);
  assert.deepEqual(change.map((r) => [r.entryType, r.amountCents, r.plan, r.seats, r.paidBasisAfterCents]), [['entitlement_change', 0, 'business', 50, 15500]]);
  assert.equal(state.paidBasisCents, 15500);
  assert.equal(state.version, 2);
});

test('a scheduled decrease writes nothing now and does not bump the version', () => {
  const { rows, state } = run(team(18), [{ to: team(15), remaining: 20 }]);
  assert.equal(rows.length, 2);
  assert.equal(state.version, 1);
  assert.equal(state.seats, 18);
});

test('deduplication keys never collide inside one operation, and a replayed operation would collide on all of them', () => {
  const { rows } = run(starter(5), [{ to: team(9), remaining: 20 }]);
  const keys = rows.map((r) => `${r.operationId}|${r.entryType}|${r.sequence}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('a corrupt ledger is refused instead of guessed at', () => {
  assert.throws(() => rebuildSubscription([]), /never activated/);
  const { rows } = run(starter(5), [{ to: team(9), remaining: 20 }]);
  assert.throws(() => rebuildSubscription(rows.slice(2)), /before any period started/);
  assert.throws(() => rebuildSubscription([{ ...rows[0]!, plan: null }]), /lacks its state/);
});
