import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { inviteFormCopy } from './inviteFormCopy';
import { describeSendInviteFailure } from './sendInviteFailure';

const api = (status: number, code: string, details?: unknown, retryAfter: number | null = null) => new ApiError(status, code, 'x', 'req-7', details, retryAfter);

test('an address that is already on the team, or already invited, is an error under the email field (Figma 291:781, 291:821)', () => {
  assert.deepEqual(describeSendInviteFailure(api(409, 'already_member')), { kind: 'fields', fields: { email: inviteFormCopy.alreadyMember } });
  assert.deepEqual(describeSendInviteFailure(api(409, 'invite_pending')), { kind: 'fields', fields: { email: inviteFormCopy.alreadyPending } });
});

test('the server rejecting the address shape is the same "Enter a valid email address" (Figma 291:741); a 400 about something else is generic', () => {
  assert.deepEqual(describeSendInviteFailure(api(400, 'validation_failed', [{ path: 'email', code: 'invalid_format' }])), { kind: 'fields', fields: { email: inviteFormCopy.emailInvalid } });
  assert.deepEqual(describeSendInviteFailure(api(400, 'validation_failed', [{ path: 'role', code: 'invalid_value' }])), { kind: 'generic', message: bannerCopy.generic, reference: 'req-7' });
  assert.equal(describeSendInviteFailure(api(400, 'validation_failed'))?.kind, 'generic');
});

test('rate limited reads "Too many attempts. Try again later." without a wait, and with the server\'s wait when it gives one (Figma 291:861)', () => {
  assert.deepEqual(describeSendInviteFailure(api(429, 'rate_limited')), { kind: 'rate_limited', message: bannerCopy.rateLimitedNoWait });
  assert.equal(describeSendInviteFailure(api(429, 'rate_limited', undefined, 600))?.kind, 'rate_limited');
});

test('offline, a refused role (403 or 404), and everything else', () => {
  assert.deepEqual(describeSendInviteFailure(new OfflineError()), { kind: 'offline', message: inviteFormCopy.offline });
  assert.equal(describeSendInviteFailure(api(403, 'forbidden'))?.kind, 'not_allowed');
  assert.equal(describeSendInviteFailure(api(404, 'not_found'))?.kind, 'not_allowed');
  assert.deepEqual(describeSendInviteFailure(api(500, 'internal')), { kind: 'generic', message: bannerCopy.generic, reference: 'req-7' });
  assert.deepEqual(describeSendInviteFailure(new NetworkError('x', true)), { kind: 'generic', message: bannerCopy.generic, reference: null });
});

test('a session that ended or an account that changed shows nothing', () => {
  for (const e of [new StaleAccountError(), new SessionEndedError('refresh_rejected'), new NotSignedInError()]) assert.equal(describeSendInviteFailure(e), null);
});
