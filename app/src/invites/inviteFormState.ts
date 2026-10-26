import { inviteFormCopy } from './inviteFormCopy';
import type { InvitableRole } from '../teams/teamResponses';

/** Presence only, on tap (same rule as sign-up and create-team). Whether the address is well formed is the server's decision. */
export function validateInviteEmail(email: string): string | undefined {
  return email.trim() === '' ? inviteFormCopy.emailInvalid : undefined;
}

/**
 * Which role the form shows. The options are exactly what the server says the caller may invite (an Owner: Manager or Staff; a Manager: Staff only;
 * never Owner). Staff is the starting choice when it is allowed (Figma). A person who may grant only one role sees it, with the field disabled
 * (Figma 103:2462). `null` when the server offers nothing: the form is not for this person.
 */
export function roleChoice(
  invitableRoles: readonly InvitableRole[],
  chosen: InvitableRole | null,
): { selected: InvitableRole; options: InvitableRole[]; canChoose: boolean } | null {
  if (invitableRoles.length === 0) return null;
  const selected = chosen !== null && invitableRoles.includes(chosen) ? chosen : invitableRoles.includes('staff') ? 'staff' : invitableRoles[0]!;
  return { selected, options: [...invitableRoles], canChoose: invitableRoles.length > 1 };
}
