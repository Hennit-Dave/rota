/**
 * Every user-facing string on the invite form, the role sheet and the "Invitation sent" screen (Figma 05 Team: invite 8:209, states 291:655 to
 * 291:932, role sheets 291:963 and 291:988, invite-sent 8:229, action error 292:890). Marked "not in Figma yet" where the design has no frame.
 */
export const inviteFormCopy = {
  title: 'Invite a teammate',
  subtitle: 'Send an invitation by email.',
  emailLabel: 'Email address',
  emailHelper: 'We’ll send the invitation here.',
  roleLabel: 'Role',
  roleHelper: 'Choose a role for this teammate.',
  // The server refused because every seat is taken or held by an invitation that is still waiting (not in Figma yet).
  seatLimit: 'This team has no free seat. Every seat is taken or held by an invitation that is still waiting.',
  submit: 'Send invitation',
  emailInvalid: 'Enter a valid email address.', // 291:741
  alreadyMember: 'This person is already on your team.', // 291:781
  alreadyPending: 'An invitation is already pending for this email.', // 291:821
  offline: 'You’re offline. Sending an invitation needs a connection.', // 291:889
  notAllowed: 'You can’t invite people to this team.', // not in Figma yet: the person's role changed, the server refused
  loadingPermissions: 'Checking what you can do here…', // not in Figma yet
  sheetTitle: 'Role', // 291:978

  // Invite by link (ADR 0025, issue #37): not in Figma yet; the layout is the invite form and "Invitation sent" with the same components (Dave, 2026-10-28).
  link: {
    action: 'Create an invite link',
    actionHelper: 'Or share a link instead. It can be used once, as Staff.',
    creating: 'Creating…',
    limit: 'This team already has the most invite links waiting. Revoke one to make another.',
    title: 'Invite link ready',
    subtitle: (until: string) => `Share it with one person. It works until ${until}.`,
    bannerTitle: 'Anyone with this link can join once',
    bannerBody: 'They join as Staff. You won’t see this link again after you leave this screen.',
    cardTitle: 'Invite link',
    pending: (role: string) => `Pending · ${role}`,
    copy: 'Copy link',
    copied: 'Link copied',
    copyFailed: 'We couldn’t copy the link. Share it instead.',
    share: 'Share link',
    shareMessage: (team: string | undefined, link: string) => (team ? `Join ${team} on Rota: ${link}` : `Join my team on Rota: ${link}`),
    backToTeam: 'Back to team',
  },

  sent: {
    title: 'Invitation sent', // 8:229
    subtitle: (email: string) => `${email} can join when they accept.`,
    queuedTitle: 'Email queued',
    queuedBody: 'We’ll send the invitation shortly.',
    pending: (role: string) => `Pending · ${role}`,
    backToTeam: 'Back to team',
    resend: 'Resend invitation',
    resending: 'Sending…', // not in Figma yet
    resendFailedTitle: 'We couldn’t resend the invitation.', // 292:890
    resendFailedBody: 'Please try again.',
  },
} as const;
