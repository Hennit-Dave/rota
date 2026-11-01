import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { describeInvitationActionFailure } from '../invites/invitationActionFailure';
import { describeSendInviteFailure } from '../invites/sendInviteFailure';
import { describeShiftFailure } from '../shifts/shiftFailure';
import { describeSwapFailure } from '../swaps/swapFailure';
import { parseTeamDetail } from '../teams/teamResponses';
import { json, makeHarness } from '../testkit';
import { createBillingApi } from './billingApi';
import { readOnlyMessage, renewalCopy } from './billingCopy';
import { parseOverview, parseRenewal, parseRetryAnswer } from './billingResponses';

// Renewals and the read-only state (ADR 0031). Every word and figure is the SERVER's finished text; the app shows it and decides nothing.
const TEAM = '11111111-1111-4111-8111-111111111111';
const renewal = (over: Record<string, unknown> = {}) => ({
  state: 'past_due', readOnly: false, headline: 'Your renewal payment did not go through', detail: 'Your card was declined. Your team keeps full access until 2031-06-08 (UTC).',
  amountDisplay: '$50.00', graceEndsOn: '2031-06-08', canRetry: true, ...over,
});
const overview = (over: Record<string, unknown> = {}) => ({
  testModeNotice: 'Test mode.', activated: true, plans: [], members: 3, seatLimit: 9,
  subscription: { plan: 'team', planName: 'Team', seats: 9, monthlyDisplay: '$50.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01' },
  openOperation: null, scheduledChange: null, savedCard: null, cardConsentWording: null, renewal: null, ...over,
});
const bad = (fn: () => unknown) => assert.throws(fn, (e) => e instanceof ApiError && e.code === 'invalid_response');

test('the overview carries the renewal as the server worded it, or null; a damaged one is refused', () => {
  assert.equal(parseOverview(overview()).renewal, null);
  assert.equal(parseOverview(overview({ renewal: undefined })).renewal, null, 'an older server answer has none');
  assert.deepEqual(parseOverview(overview({ renewal: renewal() })).renewal, renewal());
  for (const state of ['confirming', 'past_due', 'read_only', 'review']) assert.equal(parseRenewal(renewal({ state }))?.state, state);
  bad(() => parseOverview(overview({ renewal: renewal({ state: 'paid' }) })));
  bad(() => parseOverview(overview({ renewal: renewal({ readOnly: 'yes' }) })));
  bad(() => parseOverview(overview({ renewal: renewal({ canRetry: undefined }) })));
  bad(() => parseOverview(overview({ renewal: renewal({ graceEndsOn: 'Tuesday' }) })));
  bad(() => parseOverview(overview({ renewal: renewal({ amountDisplay: 50 }) })));
  assert.equal(parseRenewal(renewal({ amountDisplay: null, graceEndsOn: null }))?.amountDisplay, null);
});

test('retry: POST with NO body and no amount; the server answers "confirming" and the app takes that as given', async () => {
  const h = makeHarness({ handler: () => json(202, { renewal: renewal({ state: 'confirming', canRetry: false, headline: 'Confirming your payment' }) }) });
  const answer = await createBillingApi(h.client).retryRenewal(TEAM);
  assert.equal(answer.state, 'confirming');
  assert.equal(answer.canRetry, false);
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/renewal/retry`);
  assert.equal(h.calls[0]?.body, undefined, 'no amount, no team, no user: the server knows them');
  bad(() => parseRetryAnswer({}));
  bad(() => parseRetryAnswer({ renewal: null }));
});

test('the team detail carries the payment notice for the screens, or null; a damaged notice is refused', () => {
  const body = {
    team: { id: TEAM, name: 'The Olive Room', timeZone: 'Africa/Lagos' }, role: 'owner', invitableRoles: ['manager', 'staff'],
    canManageInvitations: true, canCreateInviteLink: true, canEditShifts: false, canManageBilling: true,
  };
  assert.equal(parseTeamDetail({ ...body, billingNotice: null }).billingNotice, null);
  assert.equal(parseTeamDetail(body).billingNotice, null, 'absent means none');
  const notice = { state: 'read_only', readOnly: true, headline: 'This team is read-only', detail: 'Its payment is overdue.' };
  assert.deepEqual(parseTeamDetail({ ...body, billingNotice: notice }).billingNotice, notice);
  assert.equal(parseTeamDetail({ ...body, billingNotice: notice }).canEditShifts, false, 'the server turns editing off; the app only follows');
  assert.throws(() => parseTeamDetail({ ...body, billingNotice: { ...notice, state: 'on_fire' } }), (e) => e instanceof ApiError && e.code === 'invalid_response');
  assert.throws(() => parseTeamDetail({ ...body, billingNotice: { ...notice, readOnly: 'yes' } }), (e) => e instanceof ApiError && e.code === 'invalid_response');
});

test('a write the server refuses because the team is read-only says so on every screen that writes (shifts, swaps, invitations)', () => {
  const refused = new ApiError(403, 'team_read_only', 'x', 'req-9');
  assert.deepEqual(describeShiftFailure(refused), { kind: 'banner', message: readOnlyMessage });
  assert.deepEqual(describeSwapFailure(refused), { kind: 'banner', message: readOnlyMessage });
  assert.deepEqual(describeSendInviteFailure(refused), { kind: 'not_allowed', message: readOnlyMessage });
  assert.deepEqual(describeInvitationActionFailure(refused), { kind: 'not_allowed', message: readOnlyMessage });
  assert.match(readOnlyMessage, /overdue/);
});

test('the renewal copy names no figure: the amount arrives from the server', () => {
  assert.equal(renewalCopy.amount('$50.00'), 'Renewal amount: $50.00');
  for (const text of [renewalCopy.retry, renewalCopy.retrying, renewalCopy.fixCard, renewalCopy.openBilling, renewalCopy.retryFailed, readOnlyMessage]) assert.doesNotMatch(text, /\$|\d/, text);
});
