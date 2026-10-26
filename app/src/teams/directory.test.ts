import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canInvite, showEmptyTeamCard } from './directory';
import { teamCopy } from './teamCopy';
import type { Member, TeamDetail } from './teamResponses';

const owner: Member = { userId: 'u1', name: 'Dave Hennit', role: 'owner' };
const staff: Member = { userId: 'u2', name: 'Amara Okafor', role: 'staff' };
const detail = (invitableRoles: TeamDetail['invitableRoles']): TeamDetail => ({
  team: { id: 't', name: 'The Olive Room', timeZone: 'Africa/Lagos' },
  role: 'owner',
  invitableRoles,
  canManageInvitations: invitableRoles.length > 0,
});

test('the "invite your first team member" card shows when you are the only one, and never when others have joined', () => {
  assert.equal(showEmptyTeamCard([owner], 'u1'), true);
  assert.equal(showEmptyTeamCard([], 'u1'), true);
  assert.equal(showEmptyTeamCard([owner, staff], 'u1'), false);
  assert.equal(showEmptyTeamCard([staff], 'u1'), false, 'one member who is not me is not "just me"');
});

test('"Invite a teammate" shows only when the server offers at least one role; Staff and nothing-yet never see it', () => {
  assert.equal(canInvite(detail(['manager', 'staff'])), true);
  assert.equal(canInvite(detail(['staff'])), true);
  assert.equal(canInvite(detail([])), false);
  assert.equal(canInvite(undefined), false, 'nothing is shown before the server has answered');
});

test('the member count reads "1 active member" and "5 active members"', () => {
  assert.equal(teamCopy.subtitle('The Olive Room', 1), 'The Olive Room · 1 active member');
  assert.equal(teamCopy.subtitle('The Olive Room', 5), 'The Olive Room · 5 active members');
});

import { directoryStatus } from './directory';

const base = { teamId: null as string | null, teams: { isError: false, count: undefined as number | undefined }, meFailed: false, hasMembers: false, membersFailed: false, detailFailed: false };

test('the Team screen never waits for ever: with no team selected and the team list failed, it is the error state (Try again)', () => {
  assert.equal(directoryStatus({ ...base, teams: { isError: true, count: undefined } }), 'failed');
});

test('no team selected and the list loaded empty: no team, so Home takes the person on to Create team', () => {
  assert.equal(directoryStatus({ ...base, teams: { isError: false, count: 0 } }), 'no_team');
});

test('still loading the team list, or about to select the first team: loading', () => {
  assert.equal(directoryStatus(base), 'loading');
  assert.equal(directoryStatus({ ...base, teams: { isError: false, count: 2 } }), 'loading');
});

test('a team is selected: failed when the roster or the permission answer failed, loading while they are on their way, ready with a roster', () => {
  assert.equal(directoryStatus({ ...base, teamId: 't1', membersFailed: true }), 'failed');
  assert.equal(directoryStatus({ ...base, teamId: 't1', detailFailed: true }), 'failed');
  assert.equal(directoryStatus({ ...base, teamId: 't1' }), 'loading');
  assert.equal(directoryStatus({ ...base, teamId: 't1', hasMembers: true }), 'ready');
});

test('a roster already on screen stays on screen even if a later refresh fails', () => {
  assert.equal(directoryStatus({ ...base, teamId: 't1', hasMembers: true, membersFailed: true }), 'ready');
  assert.equal(directoryStatus({ ...base, teams: { isError: true, count: undefined }, hasMembers: true }), 'ready');
});

test('the API is down at launch: even "who am I" failed, so the team list never started, and that is the error state too', () => {
  assert.equal(directoryStatus({ ...base, meFailed: true }), 'failed');
  assert.equal(directoryStatus({ ...base, meFailed: true, teams: { isError: false, count: 0 } }), 'no_team', 'a loaded empty list still wins');
});
