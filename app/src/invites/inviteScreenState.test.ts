import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, OfflineError, StaleAccountError } from '../api/errors';
import { inviteView, type PreviewState } from './inviteScreenState';
import type { PendingInvitePreview } from './inviteResponses';

const pending: PendingInvitePreview = {
  status: 'pending',
  kind: 'email',
  team: { name: 'The Olive Room' },
  role: 'staff',
  inviter: { name: 'Dave Hennit', role: 'owner' },
  email: 'amara@example.com',
  account: 'none',
};
const ok = (data: PendingInvitePreview): PreviewState => ({ status: 'success', data });
const team = { id: '33333333-3333-4333-8333-333333333333', name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'staff' as const };
const base = { token: 'tok', acceptFailure: null };
const api = (status: number, code: string) => new ApiError(status, code, 'x', 'req-1');

test('a cold start waits for the verified session before showing anything', () => {
  assert.equal(inviteView({ ...base, session: 'restoring', preview: ok(pending) }).kind, 'blank');
});

test('no token in the link is the "unavailable" screen, with no request needed', () => {
  assert.equal(inviteView({ session: 'signedOut', token: null, preview: { status: 'pending' }, acceptFailure: null }).kind, 'unavailable');
});

test('signed out: the invite with Sign in and Create account (invite-accept)', () => {
  const view = inviteView({ ...base, session: 'signedOut', preview: ok(pending) });
  assert.equal(view.kind, 'signed_out');
});

test('signed in as the invited account, or when the server could not tell: the confirm screen (invite-confirm)', () => {
  assert.equal(inviteView({ ...base, session: 'signedIn', preview: ok({ ...pending, account: 'matches' }) }).kind, 'confirm');
  assert.equal(inviteView({ ...base, session: 'signedIn', preview: ok({ ...pending, account: 'none' }) }).kind, 'confirm', 'accept decides');
});

test('signed in as a different account: the wrong-account screen, before anything is accepted', () => {
  assert.equal(inviteView({ ...base, session: 'signedIn', preview: ok({ ...pending, account: 'different' }) }).kind, 'wrong_account');
});

test('already a member goes to the team, but only for a signed-in caller', () => {
  const preview: PreviewState = { status: 'success', data: { status: 'already_member', team } };
  assert.deepEqual(inviteView({ ...base, session: 'signedIn', preview }), { kind: 'already_member', team });
  assert.equal(inviteView({ ...base, session: 'signedOut', preview }).kind, 'unavailable');
});

test('preview errors: 404 is unavailable, offline / rate limit / other are a retryable problem, a changed session just keeps loading', () => {
  const view = (error: unknown) => inviteView({ ...base, session: 'signedOut', preview: { status: 'error', error } });
  assert.equal(view(api(404, 'invite_unavailable')).kind, 'unavailable');
  const offline = view(new OfflineError());
  assert.equal(offline.kind === 'problem' && offline.failure.kind, 'offline');
  assert.equal(view(api(429, 'rate_limited')).kind, 'problem');
  assert.equal(view(api(500, 'internal')).kind, 'problem');
  assert.equal(view(new StaleAccountError()).kind, 'loading');
  assert.equal(inviteView({ ...base, session: 'signedOut', preview: { status: 'pending' } }).kind, 'loading');
});

test('a failed accept that says unavailable or wrong account replaces the confirm screen; other failures leave it (shown as a banner)', () => {
  const confirm = ok({ ...pending, account: 'matches' });
  assert.equal(inviteView({ ...base, session: 'signedIn', preview: confirm, acceptFailure: { kind: 'unavailable' } }).kind, 'unavailable');
  assert.equal(inviteView({ ...base, session: 'signedIn', preview: confirm, acceptFailure: { kind: 'wrong_account' } }).kind, 'wrong_account');
  assert.equal(inviteView({ ...base, session: 'signedIn', preview: confirm, acceptFailure: { kind: 'generic', message: 'x', reference: null } }).kind, 'confirm');
});

test('after a log out, an old accept failure does not follow the person to the signed-out invitation', () => {
  const view = inviteView({ ...base, session: 'signedOut', preview: ok(pending), acceptFailure: { kind: 'wrong_account' } });
  assert.equal(view.kind, 'signed_out');
});

test('offline and a timeout both end on the retryable problem screen, never on a screen that waits for ever', () => {
  const view = (error: unknown) => inviteView({ ...base, session: 'signedOut', preview: { status: 'error', error } });
  const offline = view(new OfflineError());
  assert.equal(offline.kind === 'problem' && offline.failure.kind, 'offline');
  const timedOut = view(new NetworkError('timed out', true));
  assert.equal(timedOut.kind === 'problem' && timedOut.failure.kind, 'generic');
});
