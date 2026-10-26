import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { pickSelectedTeamId, teamsQueryKey, type TeamSummary } from '../teams/teamResponses';
import { applyAcceptedTeam } from './acceptedTeam';

const userId = '22222222-2222-4222-8222-222222222222';
const other: TeamSummary = { id: '11111111-1111-4111-8111-111111111111', name: 'Other Cafe', timeZone: 'Europe/London', role: 'owner' };
const joined: TeamSummary = { id: '33333333-3333-4333-8333-333333333333', name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'staff' };

function setup(initial?: TeamSummary[]) {
  const queryClient = new QueryClient();
  if (initial) queryClient.setQueryData(teamsQueryKey(userId), initial);
  const selected: Array<string | null> = [];
  return { queryClient, selected, deps: { queryClient, userId, selectTeam: (id: string | null) => selected.push(id) } };
}

test('an account that already has another team: the accepted team joins the list from the accept answer and is selected', () => {
  const { queryClient, selected, deps } = setup([other]);
  applyAcceptedTeam(deps, joined);
  const list = queryClient.getQueryData<TeamSummary[]>(teamsQueryKey(userId));
  assert.deepEqual(list, [other, joined], 'the other team stays, the accepted one is added');
  assert.deepEqual(selected, [joined.id]);
  // The home screen keeps a selection the list has; without the seed it would have moved to the first team.
  assert.equal(pickSelectedTeamId(list ?? [], joined.id), joined.id);
  assert.equal(pickSelectedTeamId([other], joined.id), other.id, 'control: without the seed the selection would be lost');
});

test('the list is marked stale for a refetch from the server, including when nothing is watching it', () => {
  const { queryClient, deps } = setup([other]);
  applyAcceptedTeam(deps, joined);
  assert.equal(queryClient.getQueryState(teamsQueryKey(userId))?.isInvalidated, true);
});

test('a team already in the list is not added twice (a replay, or a list that already caught up)', () => {
  const { queryClient, selected, deps } = setup([other, { ...joined, role: 'manager' }]);
  applyAcceptedTeam(deps, joined);
  assert.deepEqual(queryClient.getQueryData<TeamSummary[]>(teamsQueryKey(userId)), [other, joined]);
  assert.deepEqual(selected, [joined.id]);
});

test('no teams loaded yet: the list starts with the accepted team and it is selected', () => {
  const { queryClient, selected, deps } = setup();
  applyAcceptedTeam(deps, joined);
  assert.deepEqual(queryClient.getQueryData<TeamSummary[]>(teamsQueryKey(userId)), [joined]);
  assert.deepEqual(selected, [joined.id]);
});

test('another account\'s list is never touched', () => {
  const { queryClient, deps } = setup([other]);
  const otherUser = '44444444-4444-4444-8444-444444444444';
  queryClient.setQueryData(teamsQueryKey(otherUser), [other]);
  applyAcceptedTeam(deps, joined);
  assert.deepEqual(queryClient.getQueryData<TeamSummary[]>(teamsQueryKey(otherUser)), [other]);
});

test('without a user ID the team is still selected', () => {
  const selected: Array<string | null> = [];
  applyAcceptedTeam({ queryClient: new QueryClient(), userId: undefined, selectTeam: (id) => selected.push(id) }, joined);
  assert.deepEqual(selected, [joined.id]);
});
