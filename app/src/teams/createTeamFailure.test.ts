import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, OfflineError, StaleAccountError } from '../api/errors';
import { bannerCopy, createTeamCopy } from '../auth/copy';
import { describeCreateTeamFailure } from './createTeamFailure';
import { validateCreateTeam } from './createTeamValidation';

const validation = (details: unknown) => new ApiError(400, 'validation_failed', 'x', 'req-1', details);

test('field errors come from the server details, and the length limit is the server\'s number', () => {
  const failure = describeCreateTeamFailure(
    validation([
      { path: 'name', code: 'too_long', max: 80 },
      { path: 'timeZone', code: 'invalid' },
    ]),
  );
  assert.deepEqual(failure, {
    kind: 'fields',
    fields: { name: 'Use 80 characters or fewer.', timeZone: createTeamCopy.timeZoneInvalid },
  });
});

test('an empty name from the server reads as "Enter a team name."; unknown paths are ignored, and nothing mappable is generic with the reference', () => {
  assert.deepEqual(describeCreateTeamFailure(validation([{ path: 'name', code: 'too_short', min: 1 }])), {
    kind: 'fields',
    fields: { name: createTeamCopy.nameRequired },
  });
  assert.deepEqual(describeCreateTeamFailure(validation([{ path: 'role', code: 'unrecognized_key' }])), {
    kind: 'generic',
    message: bannerCopy.generic,
    reference: 'req-1',
  });
  assert.equal(describeCreateTeamFailure(validation('not an array'))?.kind, 'generic');
});

test('429 shows the server\'s wait; 503 and anything else is the generic error with the request ID', () => {
  const limited = describeCreateTeamFailure(new ApiError(429, 'rate_limited', 'x', 'r', undefined, 1800));
  assert.deepEqual(limited, { kind: 'rate_limited', message: bannerCopy.rateLimited('in 30 minutes') });
  assert.deepEqual(describeCreateTeamFailure(new ApiError(429, 'rate_limited', 'x', 'r')), {
    kind: 'rate_limited',
    message: bannerCopy.rateLimitedNoWait,
  });
  assert.deepEqual(describeCreateTeamFailure(new ApiError(503, 'service_unavailable', 'x', 'req-3')), {
    kind: 'generic',
    message: bannerCopy.generic,
    reference: 'req-3',
  });
  assert.deepEqual(describeCreateTeamFailure(new NetworkError('timeout', true)), { kind: 'generic', message: bannerCopy.generic, reference: null });
});

test('offline is its own state; a result for a previous account shows nothing', () => {
  assert.deepEqual(describeCreateTeamFailure(new OfflineError()), { kind: 'offline', message: bannerCopy.offline });
  assert.equal(describeCreateTeamFailure(new StaleAccountError()), null);
});

test('presence checks only, run on tap: an empty or blank name, and no time zone', () => {
  assert.deepEqual(validateCreateTeam({ name: '   ', timeZone: null }), {
    name: createTeamCopy.nameRequired,
    timeZone: createTeamCopy.timeZoneRequired,
  });
  assert.deepEqual(validateCreateTeam({ name: 'The Olive Room', timeZone: 'Africa/Lagos' }), {});
  assert.deepEqual(validateCreateTeam({ name: 'x'.repeat(500), timeZone: 'Africa/Lagos' }), {}, 'the length limit is the server\'s decision');
});
