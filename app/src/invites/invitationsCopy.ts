import type { InvitationView } from './inviteResponses';
import { roleLabel } from './inviteCopy';

/**
 * Every user-facing string on the pending-invitations list, the revoke confirmation and the directory's Invitations block (Figma 05 Team: Pending
 * invites 292:526 and states 292:610 to 292:890, email-not-sent 294:3986, revoke-confirm 292:988, Team directory 8:181). Marked where there is no frame.
 */
export const invitationsCopy = {
  title: 'Pending invitations',
  subtitle: 'People who haven’t joined yet.',
  loading: 'Loading invitations…', // 292:610
  emptyTitle: 'No pending invitations', // 292:675
  emptyBody: 'Invitations you send will show here.',
  invite: 'Invite a teammate',
  couldNotLoadTitle: 'We couldn’t load invitations.', // 292:725
  couldNotLoadBody: 'Check your connection, then try again.',
  retry: 'Try again',
  resend: 'Resend',
  revoke: 'Revoke',
  resendFailedTitle: 'We couldn’t resend the invitation.', // 292:890
  resendFailedBody: 'Please try again.',
  revokeFailedTitle: 'We couldn’t revoke the invitation.', // not in Figma yet
  revokeFailedBody: 'Please try again.',
  gone: 'This invitation is no longer pending.', // not in Figma yet: it was accepted, revoked or expired meanwhile
  notAllowed: 'You can’t manage invitations for this team.', // not in Figma yet

  directory: {
    heading: 'Invitations', // 32:1323
    pending: 'Invitation pending',
    notSent: 'Email not sent',
    manage: 'Manage invitations', // 294:3985
  },

  revokeConfirm: {
    title: (email: string) => `Revoke invitation for ${email}?`, // 292:988
    subtitle: 'They won’t be able to join with this invitation.',
    cardTitle: 'Before you continue',
    cardBody: 'They will see this invitation as no longer available. You can send a new invitation later.',
    revoke: 'Revoke invitation',
    revoking: 'Revoking…', // not in Figma yet
    keep: 'Keep invitation',
    loading: 'Loading the invitation…', // not in Figma yet
    back: 'Back to invitations', // not in Figma yet
  },
} as const;

/** "Email not sent · Staff" (danger) or "Pending · Manager" (muted), from the server's email state (Figma 294:3986). Queued and sent both read Pending. */
export function invitationCaption(invitation: Pick<InvitationView, 'emailStatus' | 'role'>): { text: string; tone: 'muted' | 'danger' } {
  const role = roleLabel[invitation.role];
  return invitation.emailStatus === 'failed' ? { text: `Email not sent · ${role}`, tone: 'danger' } : { text: `Pending · ${role}`, tone: 'muted' };
}

/** The shorter line in the directory's Invitations block (Figma 32:1324): "Invitation pending", or "Email not sent" when the server says so. */
export function directoryInvitationCaption(invitation: Pick<InvitationView, 'emailStatus'>): { text: string; tone: 'muted' | 'danger' } {
  return invitation.emailStatus === 'failed'
    ? { text: invitationsCopy.directory.notSent, tone: 'danger' }
    : { text: invitationsCopy.directory.pending, tone: 'muted' };
}
