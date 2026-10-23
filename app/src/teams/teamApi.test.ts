import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, OfflineError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createTeamApi } from './teamApi';

const created = {
  team: { id: '11111111-1111-4111-8111-111111111111', name: 'The Olive Room', timeZone: 'Africa/Lagos', createdAt: '2026-10-23T10:00:00.000Z' },
  role: 'owner',
};

test('createTeam: POST /teams with the access token, a trimmed name and the time zone, and nothing else', async () => {
  const h = makeHarness({ handler: () => json(201, created) });
  const team = await createTeamApi(h.client).createTeam({ name: '  The Olive Room  ', timeZone: 'Africa/Lagos' });
  assert.deepEqual(team, { id: created.team.id, name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'owner' });
  assert.equal(h.calls[0]?.path, '/teams');
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
  assert.deepEqual(h.calls[0]?.body, { name: 'The Olive Room', timeZone: 'Africa/Lagos' }, 'no user, role or team ID is ever sent');
});

test('listTeams: GET /teams with the access token', async () => {
  const h = makeHarness({ handler: () => json(200, { teams: [{ id: created.team.id, name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'owner' }] }) });
  const teams = await createTeamApi(h.client).listTeams();
  assert.equal(teams.length, 1);
  assert.equal(h.calls[0]?.path, '/teams');
  assert.equal(h.calls[0]?.method, 'GET');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('server errors reach the screen unchanged: 400 details, 429 wait and the request ID', async () => {
  const h = makeHarness({
    handler: () =>
      json(
        400,
        { error: { code: 'validation_failed', message: 'x', requestId: 'req-9', details: [{ path: 'name', code: 'too_long', max: 80 }] } },
        { 'X-Request-Id': 'req-9' },
      ),
  });
  await assert.rejects(createTeamApi(h.client).createTeam({ name: 'x', timeZone: 'Africa/Lagos' }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'validation_failed');
    assert.equal(e.requestId, 'req-9');
    assert.deepEqual(e.details, [{ path: 'name', code: 'too_long', max: 80 }]);
    return true;
  });

  const limited = makeHarness({
    handler: () => json(429, { error: { code: 'rate_limited', message: 'x', requestId: 'r', retryAfterSeconds: 1800 } }, { 'Retry-After': '1800' }),
  });
  await assert.rejects(createTeamApi(limited.client).createTeam({ name: 'x', timeZone: 'Africa/Lagos' }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.retryAfterSeconds, 1800);
    return true;
  });
});

test('offline: nothing is sent and the screen gets an OfflineError (a team is never created later, app-state.md)', async () => {
  const h = makeHarness({ handler: () => json(201, created), online: () => false });
  await assert.rejects(createTeamApi(h.client).createTeam({ name: 'x', timeZone: 'Africa/Lagos' }), (e) => e instanceof OfflineError);
  assert.equal(h.calls.length, 0);
});

test('an unreadable success answer is an error, not a team', async () => {
  const h = makeHarness({ handler: () => json(201, { nope: true }) });
  await assert.rejects(createTeamApi(h.client).createTeam({ name: 'x', timeZone: 'Africa/Lagos' }), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
});
