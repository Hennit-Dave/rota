import { isRecord, isRole, parseSummary, unreadable, type InvitableRole, type TeamRole, type TeamSummary } from '../teams/teamResponses';

export type InvitedRole = InvitableRole;

/**
 * A live invitation, as POST /invitations/preview describes it. `kind` is `email` (tied to one address) or `link` (anyone holding the link may use it
 * once, ADR 0025: no address, so `email` is null). `account` is the server's comparison of the caller with the invited address; for a link and a
 * signed-in caller it is 'open' (nothing to compare).
 */
export interface PendingInvitePreview {
  status: 'pending';
  kind: InvitationKind;
  team: { name: string };
  role: InvitedRole;
  inviter: { name: string; role: TeamRole | null };
  email: string | null;
  account: 'matches' | 'different' | 'none' | 'open';
}

export type InvitationKind = 'email' | 'link';

/** The caller already accepted this exact link and is still a member (ADR 0017): the same team and role the accept answer gives. */
export interface AlreadyMemberPreview {
  status: 'already_member';
  team: TeamSummary;
}

export type InvitePreview = PendingInvitePreview | AlreadyMemberPreview;

const isInvitedRole = (value: unknown): value is InvitedRole => value === 'manager' || value === 'staff';
const isAccount = (value: unknown): value is PendingInvitePreview['account'] =>
  value === 'matches' || value === 'different' || value === 'none' || value === 'open';
const isKind = (value: unknown): value is InvitationKind => value === 'email' || value === 'link';

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

  const { kind, team, role, inviter, email, account } = body;
  if (!isRecord(team) || typeof team.name !== 'string') throw unreadable();
  // An email invitation always has its address and a link never does: anything else is not the server's answer.
  if (!isKind(kind) || !isInvitedRole(role) || !isAccount(account)) throw unreadable();
  if (kind === 'email' ? typeof email !== 'string' : email !== null) throw unreadable();
  if (!isRecord(inviter) || typeof inviter.name !== 'string') throw unreadable();
  if (inviter.role !== null && !isRole(inviter.role)) throw unreadable();
  return {
    status: 'pending',
    kind,
    team: { name: team.name },
    role,
    inviter: { name: inviter.name, role: inviter.role },
    email: email as string | null,
    account,
  };
}

/** An invitation the team's Owner or Manager sent. `emailStatus` and the two `can…` flags are the server's: the app only displays them. */
export interface InvitationView {
  id: string;
  /** `link`: not tied to an address (`email` is null) and sends no email (`emailStatus` is null). */
  kind: InvitationKind;
  email: string | null;
  role: InvitedRole;
  expiresAt: string;
  emailStatus: 'queued' | 'sent' | 'failed' | null;
  canResend: boolean;
  canRevoke: boolean;
}

const isEmailStatus = (value: unknown): value is NonNullable<InvitationView['emailStatus']> => value === 'queued' || value === 'sent' || value === 'failed';

/** One invitation as the server describes it. */
export function parseInvitation(value: unknown): InvitationView {
  if (!isRecord(value)) throw unreadable();
  const { id, kind, email, role, expiresAt, emailStatus, canResend, canRevoke } = value;
  if (typeof id !== 'string' || !isKind(kind) || !isInvitedRole(role) || typeof expiresAt !== 'string') throw unreadable();
  if (typeof canResend !== 'boolean' || typeof canRevoke !== 'boolean') throw unreadable();
  // An email invitation has its address and its email state; a link has neither. Anything else is not the server's answer.
  if (kind === 'email') {
    if (typeof email !== 'string' || !isEmailStatus(emailStatus)) throw unreadable();
    return { id, kind, email, role, expiresAt, emailStatus, canResend, canRevoke };
  }
  if (email !== null || emailStatus !== null) throw unreadable();
  return { id, kind, email: null, role, expiresAt, emailStatus: null, canResend, canRevoke };
}

/** `{ invitation, link }` as POST /teams/:id/invitations/links answers. The link is in this answer only: the server keeps only its hash. */
export function parseCreatedLink(body: unknown): { invitation: InvitationView; link: string } {
  if (!isRecord(body) || typeof body.link !== 'string' || body.link === '') throw unreadable();
  const invitation = parseInvitation(body.invitation);
  if (invitation.kind !== 'link') throw unreadable();
  return { invitation, link: body.link };
}

/** `{ invitation }` as POST /teams/:id/invitations and POST …/resend answer. */
export function parseInvitationResponse(body: unknown): InvitationView {
  if (!isRecord(body)) throw unreadable();
  return parseInvitation(body.invitation);
}

/** `{ invitations: [...] }` as GET /teams/:id/invitations answers (oldest first). Throws if any part cannot be read. */
export function parseInvitationsList(body: unknown): InvitationView[] {
  if (!isRecord(body) || !Array.isArray(body.invitations)) throw unreadable();
  return body.invitations.map(parseInvitation);
}
