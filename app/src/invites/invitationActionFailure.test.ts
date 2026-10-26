import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { describeInvitationActionFailure } from './invitationActionFailure';
import { invitationsCopy } from './invitationsCopy';

const api = (status: number, code: string, retryAfter: number | null = null) => new ApiError(status, code, 'x', 'req-5', undefined, retryAfter);

test('a 404 on an invitation seen a moment ago is "no longer pending"; a 403 is "not allowed"', () => {
  assert.deepEqual(describeInvitationActionFailure(api(404, 'not_found')), { kind: 'gone', message: invitationsCopy.gone });
  assert.deepEqual(describeInvitationActionFailure(api(403, 'forbidden')), { kind: 'not_allowed', message: invitationsCopy.notAllowed });
});

test('rate limited with and without the server\'s wait, offline, and everything else is the generic "please try again"', () => {
  assert.deepEqual(describeInvitationActionFailure(api(429, 'rate_limited')), { kind: 'rate_limited', message: bannerCopy.rateLimitedNoWait });
  assert.equal(describeInvitationActionFailure(api(429, 'rate_limited', 120))?.kind, 'rate_limited');
  assert.equal(describeInvitationActionFailure(new OfflineError())?.kind, 'offline');
  assert.deepEqual(describeInvitationActionFailure(api(500, 'internal')), { kind: 'generic' });
  assert.deepEqual(describeInvitationActionFailure(new NetworkError('x', true)), { kind: 'generic' });
});

test('a session that ended or an account that changed shows nothing', () => {
  for (const e of [new StaleAccountError(), new SessionEndedError('refresh_rejected'), new NotSignedInError()]) assert.equal(describeInvitationActionFailure(e), null);
});
