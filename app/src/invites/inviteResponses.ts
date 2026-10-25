import { isRecord, isRole, parseSummary, unreadable, type InvitableRole, type TeamRole, type TeamSummary } from '../teams/teamResponses';

export type InvitedRole = InvitableRole;

/** A live invitation, as POST /invitations/preview describes it. `account` is the server's comparison of the caller with the invited address. */
export interface PendingInvitePreview {
  status: 'pending';
  team: { name: string };
  role: InvitedRole;
  inviter: { name: string; role: TeamRole | null };
  email: string;
  account: 'matches' | 'different' | 'none';
}

/** The caller already accepted this exact link and is still a member (ADR 0017): the same team and role the accept answer gives. */
export interface AlreadyMemberPreview {
  status: 'already_member';
  team: TeamSummary;
}

export type InvitePreview = PendingInvitePreview | AlreadyMemberPreview;

const isInvitedRole = (value: unknown): value is InvitedRole => value === 'manager' || value === 'staff';
const isAccount = (value: unknown): value is PendingInvitePreview['account'] =>
  value === 'matches' || value === 'different' || value === 'none';

/** `{ team: { id, name, timeZone }, role }` as POST /invitations/accept answers, reduced to the shape of the teams list. */
export function parseAcceptResponse(body: unknown): TeamSummary {
  const team = isRecord(body) && isRecord(body.team) ? body.team : null;
  const summary = team && isRecord(body) ? parseSummary({ id: team.id, name: team.name, timeZone: team.timeZone, role: body.role }) : null;
  if (!summary) throw unreadable();
  return summary;
}

/** POST /invitations/preview. Throws if any part cannot be read: showing half an invitation is worse than an error. */
export function parseInvitePreview(body: unknown): InvitePreview {
  if (!isRecord(body)) throw unreadable();
  if (body.status === 'already_member') {
    return { status: 'already_member', team: parseAcceptResponse(body) };
  }
  if (body.status !== 'pending') throw unreadable();

  const { team, role, inviter, email, account } = body;
  if (!isRecord(team) || typeof team.name !== 'string') throw unreadable();
  if (!isInvitedRole(role) || typeof email !== 'string' || !isAccount(account)) throw unreadable();
  if (!isRecord(inviter) || typeof inviter.name !== 'string') throw unreadable();
  if (inviter.role !== null && !isRole(inviter.role)) throw unreadable();
  return {
    status: 'pending',
    team: { name: team.name },
    role,
    inviter: { name: inviter.name, role: inviter.role },
    email,
    account,
  };
}

/** An invitation the team's Owner or Manager sent. `emailStatus` and the two `can…` flags are the server's: the app only displays them. */
export interface InvitationView {
  id: string;
  email: string;
  role: InvitedRole;
  expiresAt: string;
  emailStatus: 'queued' | 'sent' | 'failed';
  canResend: boolean;
  canRevoke: boolean;
}

const isEmailStatus = (value: unknown): value is InvitationView['emailStatus'] => value === 'queued' || value === 'sent' || value === 'failed';

/** One invitation as the server describes it. */
export function parseInvitation(value: unknown): InvitationView {
  if (!isRecord(value)) throw unreadable();
  const { id, email, role, expiresAt, emailStatus, canResend, canRevoke } = value;
  if (typeof id !== 'string' || typeof email !== 'string' || !isInvitedRole(role) || typeof expiresAt !== 'string') throw unreadable();
  if (!isEmailStatus(emailStatus) || typeof canResend !== 'boolean' || typeof canRevoke !== 'boolean') throw unreadable();
  return { id, email, role, expiresAt, emailStatus, canResend, canRevoke };
}

/** `{ invitation }` as POST /teams/:id/invitations and POST …/resend answer. */
export function parseInvitationResponse(body: unknown): InvitationView {
  if (!isRecord(body)) throw unreadable();
  return parseInvitation(body.invitation);
}
