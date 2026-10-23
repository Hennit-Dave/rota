import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, invitableRoles, PERMISSIONS, ROLES, type PermissionAction, type Role } from './permissions.js';

// The expected matrix, written out by hand from security.md ("Owner alone manages billing; Owner and Manager edit shifts and
// approve swaps; Staff view shifts, request swaps, edit own preferences") and the invite rules (Owner invites Manager or
// Staff, Manager invites Staff only). If this and permissions.ts disagree, one of them is wrong; docs/SECURITY.md mirrors it.
const EXPECTED: Record<PermissionAction, Role[]> = {
  'team.view': ['owner', 'manager', 'staff'],
  'members.list': ['owner', 'manager', 'staff'],
  'shifts.view': ['owner', 'manager', 'staff'],
  'swaps.request': ['owner', 'manager', 'staff'],
  'preferences.edit': ['owner', 'manager', 'staff'],
  'shifts.edit': ['owner', 'manager'],
  'swaps.approve': ['owner', 'manager'],
  'invitations.list': ['owner', 'manager'],
  'invite.manager': ['owner'],
  'invite.staff': ['owner', 'manager'],
  'billing.manage': ['owner'],
};

test('the permission table matches security.md, role by role and action by action', () => {
  assert.deepEqual(Object.keys(PERMISSIONS).sort(), Object.keys(EXPECTED).sort(), 'same set of actions');
  for (const action of Object.keys(EXPECTED) as PermissionAction[]) {
    for (const role of ROLES) {
      assert.equal(can(role, action), EXPECTED[action].includes(role), `${role} / ${action}`);
    }
  }
});

test('Owner alone manages billing; a Manager cannot invite a Manager; Staff cannot edit shifts', () => {
  assert.equal(can('owner', 'billing.manage'), true);
  assert.equal(can('manager', 'billing.manage'), false);
  assert.equal(can('staff', 'billing.manage'), false);
  assert.equal(can('manager', 'invite.manager'), false);
  assert.equal(can('manager', 'invite.staff'), true);
  assert.equal(can('staff', 'shifts.edit'), false);
  assert.equal(can('staff', 'swaps.approve'), false);
});

test('Owner may do everything any other role may (the Owner has full control)', () => {
  for (const action of Object.keys(PERMISSIONS) as PermissionAction[]) {
    assert.equal(can('owner', action), true, action);
  }
});

test('an unknown role or action is refused, never allowed by accident', () => {
  assert.equal(can('intern' as Role, 'team.view'), false);
  assert.equal(can('owner', 'nope' as PermissionAction), false);
});

test('who may invite whom, from the table: Owner offers Manager and Staff, Manager only Staff, Staff nobody, and nobody is offered Owner', () => {
  assert.deepEqual(invitableRoles('owner'), ['manager', 'staff']);
  assert.deepEqual(invitableRoles('manager'), ['staff']);
  assert.deepEqual(invitableRoles('staff'), []);
  for (const role of ROLES) assert.ok(!(invitableRoles(role) as string[]).includes('owner'));
});
