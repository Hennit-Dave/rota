import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { parseCreateTeamResponse, parseTeamsList, pickSelectedTeamId, teamsQueryKey, type TeamSummary } from './teamResponses';

const olive: TeamSummary = { id: '11111111-1111-4111-8111-111111111111', name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'owner' };
const cafe: TeamSummary = { id: '22222222-2222-4222-8222-222222222222', name: 'Cafe Two', timeZone: 'Europe/London', role: 'staff' };

test('GET /teams answer: each team with its role', () => {
  const teams = parseTeamsList({ teams: [olive, { ...cafe, extra: 'ignored' }] });
  assert.deepEqual(teams, [olive, cafe]);
  assert.deepEqual(parseTeamsList({ teams: [] }), []);
});

test('a list with one unreadable team is an error, not a shorter list', () => {
  for (const body of [
    null,
    {},
    { teams: 'nope' },
    { teams: [olive, { ...cafe, role: 'admin' }] },
    { teams: [olive, { id: 7, name: 'x', timeZone: 'y', role: 'staff' }] },
    { teams: [olive, null] },
  ]) {
    assert.throws(() => parseTeamsList(body), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
  }
});

test('POST /teams answer becomes the same shape as a list entry (the creator is the owner)', () => {
  const created = parseCreateTeamResponse({
    team: { id: olive.id, name: olive.name, timeZone: olive.timeZone, createdAt: '2026-10-23T10:00:00.000Z' },
    role: 'owner',
  });
  assert.deepEqual(created, olive);
});

test('an unreadable create answer is an error', () => {
  for (const body of [null, {}, { team: {}, role: 'owner' }, { team: { id: olive.id, name: 'x', timeZone: 'y' }, role: 'king' }]) {
    assert.throws(() => parseCreateTeamResponse(body), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
  }
});

test('the selected team: kept while the server still lists it, otherwise the first listed, otherwise none', () => {
  assert.equal(pickSelectedTeamId([olive, cafe], cafe.id), cafe.id, 'a valid choice is kept');
  assert.equal(pickSelectedTeamId([olive, cafe], null), olive.id, 'nothing chosen: the first');
  assert.equal(pickSelectedTeamId([olive], cafe.id), olive.id, 'a team the server no longer lists is dropped');
  assert.equal(pickSelectedTeamId([], cafe.id), null, 'no teams: none');
  assert.equal(pickSelectedTeamId([], null), null);
});

test('the teams query key carries the user ID (a personal response, app-state.md)', () => {
  assert.deepEqual(teamsQueryKey('u1'), ['teams', 'u1']);
  assert.notDeepEqual(teamsQueryKey('u1'), teamsQueryKey('u2'));
});
