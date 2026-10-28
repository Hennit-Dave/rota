import type { TeamRole } from '../teams/teamResponses';

/**
 * Every user-facing string on the invite-link screens (Figma 03 Authentication: invite-accept 8:119, invite-confirm 8:134,
 * invite-expired 8:146, invite-wrong-email 100:204, invite-offline 289:469). Marked "not in Figma yet" where the design has no frame:
 * those follow the login screens' patterns (agreed in the plan, 2026-10-24) and are to be added to the design later.
 */
export const roleLabel: Record<TeamRole, string> = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };

/** What a role can do, in the words of the brief's role list. Staff is Figma 8:134; Manager is not in Figma yet. */
export const roleAccess: Record<'manager' | 'staff', { title: string; body: string }> = {
  staff: { title: 'Staff access', body: 'View your shifts, request swaps and manage your preferences.' },
  manager: { title: 'Manager access', body: 'Create and edit shifts, approve swaps and manage your preferences.' },
};

export const inviteCopy = {
  loading: { title: 'Opening your invitation', subtitle: 'One moment.' }, // not in Figma yet

  signedOut: {
    title: 'You’re invited', // 8:119
    subtitle: (team: string, role: string) => `Join ${team} as ${role}.`,
    from: (inviter: string, role: string | null) => (role ? `From ${inviter} · ${role}` : `From ${inviter}`),
    body: (email: string) => `You are not signed in. Sign in or create an account with ${email} to accept.`,
    // An invite link is not tied to an address (ADR 0025): any account will do. Not in Figma yet.
    bodyLink: 'You are not signed in. Sign in or create an account to accept. This link can be used once.',
    yourRole: (role: string) => `Your role: ${role}`,
    signIn: 'Sign in',
    createAccount: 'Create account',
  },

  confirm: {
    title: (team: string, role: string) => `Join ${team} as ${role}`, // 8:134
    subtitle: (name: string) => `Signed in as ${name}`,
    accept: 'Accept invitation',
    accepting: 'Accepting…', // not in Figma yet
  },

  wrongAccount: {
    title: 'This invitation is for a different account', // 100:204
    subtitle: 'You’re signed in with a different account than the one invited.',
    bannerTitle: 'No team access was granted',
    bannerBody: 'Log out, then sign in with the invited account.',
    logOut: 'Log out and use another account',
    loggingOut: 'Logging out…', // not in Figma yet
    back: 'Back to Rota',
  },

  unavailable: {
    title: 'This invitation isn’t available', // 8:146
    subtitle: 'Ask the person who invited you for a new invitation.',
    bannerTitle: 'No team access was granted',
    bannerBody: 'This link may have expired, been used or been revoked.',
    backToLogin: 'Back to login',
    // Figma only has "Back to login" (signed-out). For someone already signed in it would be wrong, so they get this (Dave, 2026-10-24).
    backToRota: 'Back to Rota',
  },

  offline: {
    title: 'You’re offline', // 289:469
    subtitle: 'Opening an invitation needs a connection.',
    bannerTitle: 'Offline',
    bannerBody: 'Connect to the internet, then try again.',
    retry: 'Try again',
    close: 'Close',
  },

  // Rate limited and the generic error have no invite frame: the login screens' banners under this heading. Not in Figma yet.
  problem: {
    title: 'We couldn’t open this invitation',
    subtitle: 'Nothing was changed. You can try again.',
    retry: 'Try again',
    close: 'Close',
  },

  alreadyMember: { title: 'You’re already on this team', subtitle: 'Taking you there…' }, // not in Figma yet
} as const;
