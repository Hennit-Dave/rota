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
  submit: 'Send invitation',
  emailInvalid: 'Enter a valid email address.', // 291:741
  alreadyMember: 'This person is already on your team.', // 291:781
  alreadyPending: 'An invitation is already pending for this email.', // 291:821
  offline: 'You’re offline. Sending an invitation needs a connection.', // 291:889
  notAllowed: 'You can’t invite people to this team.', // not in Figma yet: the person's role changed, the server refused
  loadingPermissions: 'Checking what you can do here…', // not in Figma yet
  sheetTitle: 'Role', // 291:978

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
