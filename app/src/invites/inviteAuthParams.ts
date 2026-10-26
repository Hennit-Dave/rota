import { readInviteToken } from './inviteLink';

/** The most an email address can be (RFC 5321); a longer prefill is ignored. */
const MAX_EMAIL_LENGTH = 320;

type Param = string | string[] | undefined;

export interface InviteAuthParams {
  /**
   * The invitation the sign-in or sign-up screen was opened from, or null. It is carried in the route (memory only, never stored) so that
   * once the session starts the person is sent back to that invitation. Starting a session throws away the signed-out screens, and
   * Expo Router then lands on Home (ADR 0017), so the invitation screen cannot be relied on to still be underneath.
   */
  token: string | null;
  /** The invited address, to prefill the email field. Editable: the server compares the account's address when it is accepted. */
  email: string;
}

const first = (param: Param): string | null => {
  const value = Array.isArray(param) ? param[0] : param;
  return typeof value === 'string' ? value : null;
};

/** Reads the route params the invite screen passes to login and signup. Anything unexpected is "not from an invitation". */
export function readInviteAuthParams(params: { inviteToken?: Param; inviteEmail?: Param }): InviteAuthParams {
  const token = readInviteToken(params.inviteToken);
  const email = first(params.inviteEmail)?.trim() ?? '';
  return { token, email: token !== null && email.length <= MAX_EMAIL_LENGTH ? email : '' };
}

/** The params for opening login or signup from an invitation, or moving between them, so the invitation is not lost. */
export function inviteAuthParams(from: InviteAuthParams): { inviteToken: string; inviteEmail: string } | undefined {
  return from.token === null ? undefined : { inviteToken: from.token, inviteEmail: from.email };
}

/** Where a sign-in or sign-up goes once the session exists. */
export type AfterAuth =
  | { kind: 'invite'; token: string }
  | { kind: 'create-team' }
  | { kind: 'stay' };

/**
 * From an invitation, both flows end back on that invitation: the person joins the invited team and Create team is never shown (the brief:
 * "lands in the right team"). Otherwise sign-up continues to Create team, and login goes nowhere itself: the signed-in side takes over.
 */
export function routeAfterAuth(flow: 'login' | 'signup', invite: InviteAuthParams): AfterAuth {
  if (invite.token !== null) return { kind: 'invite', token: invite.token };
  return flow === 'signup' ? { kind: 'create-team' } : { kind: 'stay' };
}
