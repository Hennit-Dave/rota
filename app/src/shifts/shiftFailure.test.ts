import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { shiftFormCopy } from './shiftCopy';
import { describeShiftFailure } from './shiftFailure';
import { shiftLoadState } from './shiftLoadState';

const api = (status: number, code: string, details?: unknown, retry: number | null = null) => new ApiError(status, code, 'x', 'req-1', details, retry);

test('409 shift_overlap is a banner that names the problem, not a field error', () => {
  assert.deepEqual(describeShiftFailure(api(409, 'shift_overlap')), { kind: 'banner', message: shiftFormCopy.errors.overlap });
});

test('403 says the role does not allow it; 404 means the shift is gone', () => {
  assert.deepEqual(describeShiftFailure(api(403, 'forbidden')), { kind: 'banner', message: shiftFormCopy.errors.forbidden });
  assert.deepEqual(describeShiftFailure(api(404, 'not_found')), { kind: 'gone' });
});

test('400 details become field errors; the length limit is the server\'s number; an assignee who left is a banner', () => {
  assert.deepEqual(
    describeShiftFailure(
      api(400, 'validation_failed', [
        { path: 'title', code: 'too_long', max: 100 },
        { path: 'endsAt', code: 'must_be_after_start' },
      ]),
    ),
    { kind: 'fields', fields: { title: shiftFormCopy.errors.titleTooLong(100), end: shiftFormCopy.errors.endAfterStart } },
  );
  assert.deepEqual(describeShiftFailure(api(400, 'validation_failed', [{ path: 'startsAt', code: 'invalid' }])), {
    kind: 'fields',
    fields: { start: shiftFormCopy.errors.timeInvalid },
  });
  assert.deepEqual(describeShiftFailure(api(400, 'validation_failed', [{ path: 'assignedUserId', code: 'not_a_member' }])), {
    kind: 'banner',
    message: shiftFormCopy.errors.notMember,
  });
  assert.deepEqual(describeShiftFailure(api(400, 'validation_failed', [{ path: 'nonsense', code: 'x' }])), {
    kind: 'generic',
    message: bannerCopy.generic,
    reference: 'req-1',
  });
});

test('429 shows the server\'s wait; offline, network and unknown errors are their own states', () => {
  assert.deepEqual(describeShiftFailure(api(429, 'rate_limited', undefined, 1800)), { kind: 'rate_limited', message: bannerCopy.rateLimited('in 30 minutes') });
  assert.deepEqual(describeShiftFailure(api(429, 'rate_limited')), { kind: 'rate_limited', message: bannerCopy.rateLimitedNoWait });
  assert.deepEqual(describeShiftFailure(new OfflineError()), { kind: 'offline', message: bannerCopy.offline });
  assert.deepEqual(describeShiftFailure(new NetworkError('timeout', true)), { kind: 'generic', message: bannerCopy.generic, reference: null });
  assert.deepEqual(describeShiftFailure(api(503, 'service_unavailable')), { kind: 'generic', message: bannerCopy.generic, reference: 'req-1' });
});

test('a result for a previous account, or a session that ended, shows nothing: the screen follows the session', () => {
  for (const error of [new StaleAccountError(), new SessionEndedError('refresh_rejected'), new NotSignedInError()]) assert.equal(describeShiftFailure(error), null);
});

test('shiftLoadState: a 404 is "gone" even when old data is cached; other errors fail only when nothing is held', () => {
  assert.equal(shiftLoadState({ hasData: false, isError: false, error: null }), 'loading');
  assert.equal(shiftLoadState({ hasData: true, isError: false, error: null }), 'ready');
  assert.equal(shiftLoadState({ hasData: false, isError: true, error: api(500, 'internal_error') }), 'failed');
  assert.equal(shiftLoadState({ hasData: true, isError: true, error: api(500, 'internal_error') }), 'ready');
  assert.equal(shiftLoadState({ hasData: true, isError: true, error: api(404, 'not_found') }), 'gone');
  assert.equal(shiftLoadState({ hasData: false, isError: true, error: api(404, 'not_found') }), 'gone');
});
