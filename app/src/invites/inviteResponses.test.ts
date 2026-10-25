import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { parseAcceptResponse, parseInvitePreview } from './inviteResponses';

const teamId = '11111111-1111-4111-8111-111111111111';
const pending = {
  status: 'pending',
  team: { name: 'The Olive Room' },
  role: 'staff',
  inviter: { name: 'Dave Hennit', role: 'owner' },
  email: 'amara@example.com',
  account: 'none',
};

test('a pending preview is read field by field', () => {
  assert.deepEqual(parseInvitePreview(pending), pending);
  assert.deepEqual(parseInvitePreview({ ...pending, inviter: { name: 'Dave Hennit', role: null }, account: 'matches', role: 'manager' }), {
    ...pending,
    inviter: { name: 'Dave Hennit', role: null },
    account: 'matches',
    role: 'manager',
  });
});

test('an already_member preview is the accept answer plus a status', () => {
  const body = { status: 'already_member', team: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos' }, role: 'staff' };
  assert.deepEqual(parseInvitePreview(body), {
    status: 'already_member',
    team: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'staff' },
  });
});

test('anything unreadable throws rather than showing half an invitation', () => {
  const bad: unknown[] = [
    null,
    'x',
    {},
    { ...pending, status: 'other' },
    { ...pending, status: undefined },
    { ...pending, role: 'owner' },
    { ...pending, account: 'maybe' },
    { ...pending, email: 3 },
    { ...pending, team: {} },
    { ...pending, inviter: { name: 'x', role: 'boss' } },
    { ...pending, inviter: null },
    { status: 'already_member', team: { id: teamId }, role: 'staff' },
    { status: 'already_member', team: { id: teamId, name: 'x', timeZone: 'y' }, role: 'boss' },
  ];
  for (const body of bad) {
    assert.throws(() => parseInvitePreview(body), (e) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(body));
  }
});

test('the accept answer becomes a team summary, and a damaged one throws', () => {
  assert.deepEqual(parseAcceptResponse({ team: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos' }, role: 'manager' }), {
    id: teamId,
    name: 'The Olive Room',
    timeZone: 'Africa/Lagos',
    role: 'manager',
  });
  assert.throws(() => parseAcceptResponse({ team: { id: teamId, name: 'x', timeZone: 'y' } }), ApiError);
  assert.throws(() => parseAcceptResponse(null), ApiError);
});

import { parseInvitationResponse } from './inviteResponses';

const invitation = { id: 'i1', email: 'sofia@example.com', role: 'staff', expiresAt: '2026-10-30T18:33:23.352Z', emailStatus: 'queued', canResend: true, canRevoke: true };

test('an invitation answer is read field by field', () => {
  assert.deepEqual(parseInvitationResponse({ invitation }), invitation);
  assert.equal(parseInvitationResponse({ invitation: { ...invitation, emailStatus: 'failed', role: 'manager', canResend: false } }).emailStatus, 'failed');
});

test('an invitation that cannot be read throws (an owner role, an unknown email state, a missing flag)', () => {
  for (const bad of [null, {}, { invitation: null }, { invitation: { ...invitation, role: 'owner' } }, { invitation: { ...invitation, emailStatus: 'lost' } }, { invitation: { ...invitation, canRevoke: 'yes' } }, { invitation: { ...invitation, expiresAt: 5 } }]) {
    assert.throws(() => parseInvitationResponse(bad), (e) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(bad));
  }
});
