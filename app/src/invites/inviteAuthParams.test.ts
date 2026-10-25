import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inviteAuthParams, readInviteAuthParams, routeAfterAuth } from './inviteAuthParams';

const token = '3278f64b-0284-4626-bd0c-1ed21ca65413.Zm9vYmFy';

test('from an invitation: the token and the address are read, the address trimmed', () => {
  assert.deepEqual(readInviteAuthParams({ inviteToken: token, inviteEmail: ' amara@example.com ' }), { token, email: 'amara@example.com' });
  assert.deepEqual(readInviteAuthParams({ inviteToken: [token], inviteEmail: ['amara@example.com'] }), { token, email: 'amara@example.com' });
});

test('not from an invitation: no token, and an address on its own is ignored', () => {
  assert.deepEqual(readInviteAuthParams({}), { token: null, email: '' });
  assert.deepEqual(readInviteAuthParams({ inviteToken: '  ', inviteEmail: 'amara@example.com' }), { token: null, email: '' });
  assert.deepEqual(readInviteAuthParams({ inviteEmail: 'amara@example.com' }), { token: null, email: '' });
});

test('an absurdly long address is not prefilled, but the invitation stands', () => {
  assert.deepEqual(readInviteAuthParams({ inviteToken: token, inviteEmail: 'a'.repeat(400) }), { token, email: '' });
});

test('moving between login and signup carries the invitation only when there is one', () => {
  assert.deepEqual(inviteAuthParams({ token, email: 'amara@example.com' }), { inviteToken: token, inviteEmail: 'amara@example.com' });
  assert.equal(inviteAuthParams({ token: null, email: '' }), undefined);
});

test('LOGIN from an invitation returns to that invitation, never to Create team', () => {
  const next = routeAfterAuth('login', readInviteAuthParams({ inviteToken: token, inviteEmail: 'amara@example.com' }));
  assert.deepEqual(next, { kind: 'invite', token });
  assert.notEqual(next.kind, 'create-team');
});

test('SIGNUP from an invitation returns to that invitation, never to Create team', () => {
  const next = routeAfterAuth('signup', readInviteAuthParams({ inviteToken: token, inviteEmail: 'newuser@example.com' }));
  assert.deepEqual(next, { kind: 'invite', token });
  assert.notEqual(next.kind, 'create-team');
});

test('without an invitation nothing changes: signup goes to Create team, login stays for the signed-in side to take over', () => {
  const none = readInviteAuthParams({});
  assert.deepEqual(routeAfterAuth('signup', none), { kind: 'create-team' });
  assert.deepEqual(routeAfterAuth('login', none), { kind: 'stay' });
});

test('a bad token param is treated as no invitation, so it can neither redirect nor skip Create team by accident', () => {
  assert.deepEqual(routeAfterAuth('signup', readInviteAuthParams({ inviteToken: 'a'.repeat(500) })), { kind: 'create-team' });
});
