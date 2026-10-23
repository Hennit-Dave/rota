/**
 * THE permission table (security.md): one module, mirrored in docs/SECURITY.md. Every team route asks `can(role, action)`
 * and nothing else decides a permission. Roles come from the database on every request, never from a token, so a demotion
 * takes effect on the next request.
 *
 * `invite.*` are the grants security.md names: an Owner invites a Manager or Staff, a Manager invites Staff only, and
 * nobody is invited as Owner. Rows other than `team.view` and `members.list` have no route yet; they are here so a later
 * slice adds a route, not a rule.
 */
export const ROLES = ['owner', 'manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
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
} as const satisfies Record<string, readonly Role[]>;

export type PermissionAction = keyof typeof PERMISSIONS;

export function can(role: Role, action: PermissionAction): boolean {
  // Types forbid an unknown action, but this is the security boundary: anything not in the table is refused.
  if (!Object.hasOwn(PERMISSIONS, action)) return false;
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

/** The roles `role` may invite, from the table: Owner invites Manager or Staff, Manager invites Staff only, nobody invites an Owner. */
export function invitableRoles(role: Role): Array<'manager' | 'staff'> {
  const out: Array<'manager' | 'staff'> = [];
  if (can(role, 'invite.manager')) out.push('manager');
  if (can(role, 'invite.staff')) out.push('staff');
  return out;
}
