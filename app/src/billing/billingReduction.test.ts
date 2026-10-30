import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createBillingApi } from './billingApi';
import { describeBillingFailure } from './billingFailure';
import { parseChangeQuote, parseOverview, parseScheduleAnswer } from './billingResponses';

const TEAM = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
const PEOPLE = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];

const scheduled = (over: Record<string, unknown> = {}) => ({
  id: '66666666-6666-4666-8666-666666666666',
  status: 'scheduled',
  targetPlan: 'team',
  targetPlanName: 'Team',
  targetSeats: 3,
  effectiveOn: '2031-07-01',
  membersToDeactivate: [{ userId: PEOPLE[0], name: 'Sam Staff 0' }, { userId: PEOPLE[1], name: 'Sam Staff 1' }],
  fallbackAccepted: false,
  fallbackWording: null,
  message: 'Your plan changes to Team, 3 seats on 2031-07-01. Nothing is charged or refunded now.',
  canCancel: true,
  ...over,
});
const quote = (over: Record<string, unknown> = {}) => ({
  quote: {
    effect: 'at_period_end',
    supported: true,
    current: { plan: 'team', planName: 'Team', seats: 18 },
    applyNow: { plan: 'team', planName: 'Team', seats: 18 },
    atPeriodEnd: { plan: 'team', planName: 'Team', seats: 3 },
    chargeTodayDisplay: null,
    nextRenewalDisplay: '$50.00',
    remainingDays: 12,
    periodEndsOn: '2031-07-01',
    headline: 'This change takes effect at the end of your period, on 2031-07-01. Nothing is charged or refunded now.',
    reduction: { effectiveOn: '2031-07-01', activeMembers: 5, membersToDeactivate: 2, fallbackWording: 'Keep my current plan and price.' },
    testModeNotice: 'This integration uses Stripe test mode only. Live-payment eligibility has not been verified.',
    ...over,
  },
});

test('a reduction quote carries the date, how many people to choose and the fallback wording; a quote without one reads as null', () => {
  const q = parseChangeQuote(quote());
  assert.equal(q.effect, 'at_period_end');
  assert.deepEqual(q.reduction, { effectiveOn: '2031-07-01', activeMembers: 5, membersToDeactivate: 2, fallbackWording: 'Keep my current plan and price.' });
  assert.equal(parseChangeQuote(quote({ reduction: null })).reduction, null);
  const { reduction: _omitted, ...withoutField } = quote().quote;
  assert.equal(parseChangeQuote({ quote: withoutField }).reduction, null, 'an older server that sends no field');
  assert.throws(() => parseChangeQuote(quote({ reduction: { effectiveOn: 'soon', activeMembers: 5, membersToDeactivate: 2, fallbackWording: 'x' } })), (e) => e instanceof ApiError && e.code === 'invalid_response');
});

test('the overview carries the scheduled reduction as the server describes it, or null', () => {
  const base = { testModeNotice: 'n', activated: false, plans: [], subscription: null, members: 1, seatLimit: 5, openOperation: null };
  assert.equal(parseOverview(base).scheduledChange, null);
  const withChange = parseOverview({ ...base, activated: true, subscription: { plan: 'team', planName: 'Team', seats: 18, monthlyDisplay: '$59.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01' }, scheduledChange: scheduled() });
  assert.equal(withChange.scheduledChange?.status, 'scheduled');
  assert.equal(withChange.scheduledChange?.canCancel, true);
  assert.deepEqual(withChange.scheduledChange?.membersToDeactivate.map((m) => m.name), ['Sam Staff 0', 'Sam Staff 1']);
  const blocked = parseOverview({ ...base, activated: true, subscription: { plan: 'team', planName: 'Team', seats: 18, monthlyDisplay: '$59.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01' }, scheduledChange: scheduled({ status: 'blocked', canCancel: false }) });
  assert.equal(blocked.scheduledChange?.status, 'blocked');
  assert.throws(() => parseScheduleAnswer({ status: 'scheduled', scheduledChange: scheduled({ status: 'someday' }) }), (e) => e instanceof ApiError && e.code === 'invalid_response');
  assert.throws(() => parseScheduleAnswer({ status: 'applied' }), (e) => e instanceof ApiError && e.code === 'invalid_response');
});

test('schedule a reduction: POST sends ONLY the plan, the seats, the chosen people and the fallback choice, with the idempotency key as a header', async () => {
  const h = makeHarness({ handler: () => json(201, { status: 'scheduled', scheduledChange: scheduled() }) });
  const change = await createBillingApi(h.client).scheduleReduction(TEAM, { plan: 'team', seats: 3, selectedMemberIds: PEOPLE, acceptFallback: true }, KEY);
  assert.equal(change.targetSeats, 3);
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/reductions`);
  assert.deepEqual(h.calls[0]?.body, { plan: 'team', seats: 3, selectedMemberIds: PEOPLE, acceptFallback: true }, 'never an amount, a date, a price, a team or a user');
  assert.equal(h.calls[0]?.headers?.['idempotency-key'] ?? h.calls[0]?.headers?.['Idempotency-Key'], KEY);
});

test('cancel a reduction: DELETE with no body; the 204 is success; a refusal reaches the screen as the server\'s error', async () => {
  const ok = makeHarness({ handler: () => new Response(null, { status: 204 }) });
  await createBillingApi(ok.client).cancelReduction(TEAM);
  assert.equal(ok.calls[0]?.method, 'DELETE');
  assert.equal(ok.calls[0]?.path, `/teams/${TEAM}/billing/reductions/current`);
  const no = makeHarness({ handler: () => json(409, { error: { code: 'scheduled_change_unavailable', message: 'x' } }) });
  await assert.rejects(createBillingApi(no.client).cancelReduction(TEAM), (e) => e instanceof ApiError && e.code === 'scheduled_change_unavailable');
});

test('the reduction refusals become words from the server\'s code: choose people, check the choice, one already scheduled', () => {
  const api = (status: number, code: string) => new ApiError(status, code, 'x', 'req-7', undefined, null);
  const messageOf = (code: string) => (describeBillingFailure(api(422, code)) as { kind: string; message: string });
  assert.equal(messageOf('selection_required').kind, 'banner');
  assert.match(messageOf('selection_required').message, /Choose the people/);
  assert.match(messageOf('selection_invalid').message, /can’t choose yourself/);
  assert.match(messageOf('reduction_already_scheduled').message, /already scheduled/);
});
