import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, OfflineError, StaleAccountError, TokenSaveError } from '../api/errors';
import { describeAuthFailure } from './authFailure';
import { bannerCopy, fieldCopy } from './copy';
import { formatRetryWait } from './retryWait';

const validation = (details: unknown, requestId: string | null = 'req-1') =>
  new ApiError(400, 'validation_failed', 'The request was not valid.', requestId, details);

test('401 invalid_credentials on login is the banner-only credentials state, with no field marked', () => {
  const failure = describeAuthFailure('login', new ApiError(401, 'invalid_credentials', 'x', 'req-1'));
  assert.deepEqual(failure, { kind: 'credentials' });
});

test('409 email_in_use on signup is a banner, never a field error', () => {
  const failure = describeAuthFailure('signup', new ApiError(409, 'email_in_use', 'x', 'req-1'));
  assert.deepEqual(failure, { kind: 'email_in_use' });
});

test('codes from the other screen are not misread: no credentials state on signup, no email_in_use on login', () => {
  assert.equal(describeAuthFailure('signup', new ApiError(401, 'invalid_credentials', 'x', 'r'))?.kind, 'generic');
  assert.equal(describeAuthFailure('login', new ApiError(409, 'email_in_use', 'x', 'r'))?.kind, 'generic');
});

test('signup field errors: one message per field, taken from the server details, numbers from the server', () => {
  const failure = describeAuthFailure(
    'signup',
    validation([
      { path: 'name', code: 'too_short', min: 1 },
      { path: 'email', code: 'invalid_email' },
      { path: 'password', code: 'too_short', min: 15 },
    ]),
  );
  assert.deepEqual(failure, {
    kind: 'fields',
    fields: {
      name: 'Enter your name.',
      email: 'Enter a valid email address.',
      password: 'Use at least 15 characters.',
    },
  });
});

test('the minimum in the message is the server\'s number, not a constant in the app', () => {
  const failure = describeAuthFailure('signup', validation([{ path: 'password', code: 'too_short', min: 20 }]));
  assert.deepEqual(failure, { kind: 'fields', fields: { password: fieldCopy.passwordTooShort(20) } });
});

test('password too long (max from the server) and password_common', () => {
  assert.deepEqual(describeAuthFailure('signup', validation([{ path: 'password', code: 'too_long', max: 128 }])), {
    kind: 'fields',
    fields: { password: 'Use 128 characters or fewer.' },
  });
  assert.deepEqual(describeAuthFailure('signup', validation([{ path: 'password', code: 'password_common' }])), {
    kind: 'fields',
    fields: { password: 'This password is easy to guess. Try another.' },
  });
});

test('name too long uses the server\'s max', () => {
  assert.deepEqual(describeAuthFailure('signup', validation([{ path: 'name', code: 'too_long', max: 100 }])), {
    kind: 'fields',
    fields: { name: 'Use 100 characters or fewer.' },
  });
});

test('login field errors: an empty password is "Enter your password.", never a length hint', () => {
  const failure = describeAuthFailure(
    'login',
    validation([
      { path: 'email', code: 'invalid_email' },
      { path: 'password', code: 'too_short', min: 1 },
    ]),
  );
  assert.deepEqual(failure, {
    kind: 'fields',
    fields: { email: 'Enter a valid email address.', password: 'Enter your password.' },
  });
});

test('validation details the app cannot map fall back to the generic message (with the reference), never a silent no-op', () => {
  const failure = describeAuthFailure('signup', validation([{ path: 'surprise', code: 'unrecognized_key' }], 'req-77'));
  assert.deepEqual(failure, { kind: 'generic', message: bannerCopy.generic, reference: 'req-77' });
  assert.equal(describeAuthFailure('signup', validation('not an array'))?.kind, 'generic');
});

test('429: the wait comes from Retry-After and is only formatted; no value reads as the plain fallback', () => {
  const tooMany = (seconds: number | null) => new ApiError(429, 'rate_limited', 'x', 'r', undefined, seconds);
  assert.deepEqual(describeAuthFailure('login', tooMany(720)), {
    kind: 'rate_limited',
    message: 'Too many attempts. Try again in 12 minutes.',
  });
  assert.deepEqual(describeAuthFailure('login', tooMany(30)), {
    kind: 'rate_limited',
    message: 'Too many attempts. Try again in a minute.',
  });
  assert.deepEqual(describeAuthFailure('signup', tooMany(null)), {
    kind: 'rate_limited',
    message: bannerCopy.rateLimitedNoWait,
  });
});

test('formatRetryWait: rounds up to whole minutes, "a minute" at one minute or less, null when unusable', () => {
  assert.equal(formatRetryWait(1), 'in a minute');
  assert.equal(formatRetryWait(60), 'in a minute');
  assert.equal(formatRetryWait(61), 'in 2 minutes');
  assert.equal(formatRetryWait(720), 'in 12 minutes');
  assert.equal(formatRetryWait(721), 'in 13 minutes');
  assert.equal(formatRetryWait(null), null);
  assert.equal(formatRetryWait(Number.NaN), null);
  assert.equal(formatRetryWait(-5), null);
});

test('offline is its own state; the button is disabled by the screen, not by this mapping', () => {
  assert.deepEqual(describeAuthFailure('login', new OfflineError()), { kind: 'offline', message: bannerCopy.offline });
  assert.deepEqual(describeAuthFailure('signup', new OfflineError()), { kind: 'offline', message: bannerCopy.offline });
});

test('generic: 5xx and 503 carry the request ID as the reference; a timeout has none', () => {
  assert.deepEqual(describeAuthFailure('login', new ApiError(500, 'internal_error', 'x', 'req-500')), {
    kind: 'generic',
    message: 'Something went wrong. Please try again.',
    reference: 'req-500',
  });
  assert.deepEqual(describeAuthFailure('login', new ApiError(503, 'service_unavailable', 'x', 'req-503')), {
    kind: 'generic',
    message: bannerCopy.generic,
    reference: 'req-503',
  });
  assert.deepEqual(describeAuthFailure('login', new NetworkError('timed out', true)), {
    kind: 'generic',
    message: bannerCopy.generic,
    reference: null,
  });
  assert.equal(describeAuthFailure('login', new TokenSaveError())?.kind, 'generic');
  assert.equal(describeAuthFailure('login', new Error('anything'))?.kind, 'generic');
});

test('a result for a previous account shows nothing', () => {
  assert.equal(describeAuthFailure('login', new StaleAccountError()), null);
});
