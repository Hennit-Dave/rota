import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { describeInviteFailure } from './inviteFailure';

const api = (status: number, code: string, retryAfter: number | null = null) => new ApiError(status, code, 'x', 'req-9', undefined, retryAfter);

test('the server code decides: 404 is the one "unavailable", 403 is the wrong account', () => {
  assert.deepEqual(describeInviteFailure(api(404, 'invite_unavailable')), { kind: 'unavailable' });
  assert.deepEqual(describeInviteFailure(api(403, 'invite_wrong_account')), { kind: 'wrong_account' });
});

test('offline, rate limited (with and without a wait) and everything else', () => {
  assert.deepEqual(describeInviteFailure(new OfflineError()), { kind: 'offline', message: bannerCopy.offline });
  assert.equal(describeInviteFailure(api(429, 'rate_limited', 120))?.kind, 'rate_limited');
  assert.deepEqual(describeInviteFailure(api(429, 'rate_limited')), { kind: 'rate_limited', message: bannerCopy.rateLimitedNoWait });
  assert.deepEqual(describeInviteFailure(api(500, 'internal')), { kind: 'generic', message: bannerCopy.generic, reference: 'req-9' });
  assert.deepEqual(describeInviteFailure(new NetworkError('x', true)), { kind: 'generic', message: bannerCopy.generic, reference: null });
});

test('a session that ended or an account that changed shows nothing: the screen follows the session status', () => {
  assert.equal(describeInviteFailure(new StaleAccountError()), null);
  assert.equal(describeInviteFailure(new SessionEndedError('refresh_rejected')), null);
  assert.equal(describeInviteFailure(new NotSignedInError()), null);
});

test('seat_limit_reached on accept is its own warning and says the invitation is still usable; on send it is a banner', async () => {
  const { ApiError } = await import('../api/errors');
  const { describeSendInviteFailure } = await import('./sendInviteFailure');
  const error = new ApiError(409, 'seat_limit_reached', 'x', 'req-1');
  const accept = describeInviteFailure(error);
  assert.equal(accept?.kind, 'no_seat');
  assert.match((accept as { message: string }).message, /no free seat/);
  assert.equal(describeSendInviteFailure(error)?.kind, 'link_limit');
});
