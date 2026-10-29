import { ApiError } from '../api/errors';

export type TeamRole = 'owner' | 'manager' | 'staff';

/** The roles an invitation can grant: never Owner (a team has exactly one, ADR 0014). */
export type InvitableRole = 'manager' | 'staff';

/** A team the caller is in, as GET /teams and POST /teams answer. Server data, never trusted for access (the server checks every request). */
export interface TeamSummary {
  id: string;
  name: string;
  timeZone: string;
  role: TeamRole;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isRole(value: unknown): value is TeamRole {
  return value === 'owner' || value === 'manager' || value === 'staff';
}

export function parseSummary(value: unknown): TeamSummary | null {
  if (!isRecord(value)) return null;
  const { id, name, timeZone, role } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof timeZone !== 'string' || !isRole(role)) return null;
  return { id, name, timeZone, role };
}

export const unreadable = () => new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);

/** `{ teams: [...] }` as GET /teams answers. Throws if any part cannot be read: half a list is worse than an error. */
export function parseTeamsList(body: unknown): TeamSummary[] {
  if (!isRecord(body) || !Array.isArray(body.teams)) throw unreadable();
  return body.teams.map((item) => {
    const team = parseSummary(item);
    if (!team) throw unreadable();
    return team;
  });
}

/** `{ team: { id, name, timeZone, createdAt }, role }` as POST /teams answers, reduced to the same shape as the list. */
export function parseCreateTeamResponse(body: unknown): TeamSummary {
  const team = isRecord(body) && isRecord(body.team) ? body.team : null;
  const summary = team && isRecord(body) ? parseSummary({ id: team.id, name: team.name, timeZone: team.timeZone, role: body.role }) : null;
  if (!summary) throw unreadable();
  return summary;
}

/**
 * Which team is open. Keep the current choice while the server still lists it; otherwise the first team the server
 * lists (the oldest), or none. The server orders the list; the app only picks from it.
 */
export function pickSelectedTeamId(teams: readonly TeamSummary[], current: string | null): string | null {
  if (current !== null && teams.some((t) => t.id === current)) return current;
  return teams[0]?.id ?? null;
}

export const teamsQueryKey = (userId: string) => ['teams', userId] as const;

const isInvitableRole = (value: unknown): value is InvitableRole => value === 'manager' || value === 'staff';

/**
 * GET /teams/:teamId: the team, the caller's role in it, and what the caller may do here. `invitableRoles` and `canManageInvitations` come
 * from the server's permission table; the app shows what it allows and decides nothing (AGENTS.md rule 3).
 */
export interface TeamDetail {
  team: { id: string; name: string; timeZone: string };
  role: TeamRole;
  invitableRoles: InvitableRole[];
  canManageInvitations: boolean;
  /** Whether to offer "Create an invite link" (ADR 0025): the server's `invite.staff`. The server checks again when the link is made. */
  canCreateInviteLink: boolean;
  /** Whether this person may create, edit and delete shifts (the server's `shifts.edit`). The server decides again on every write. */
  canEditShifts: boolean;
  /** Whether to offer the billing screens (the server's `billing.manage`: the Owner alone). The server checks again on every billing request. */
  canManageBilling: boolean;
}

export function parseTeamDetail(body: unknown): TeamDetail {
  if (!isRecord(body) || !isRecord(body.team)) throw unreadable();
  const { id, name, timeZone } = body.team;
  const { role, invitableRoles, canManageInvitations, canCreateInviteLink, canEditShifts, canManageBilling } = body;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof timeZone !== 'string' || !isRole(role)) throw unreadable();
  if (!Array.isArray(invitableRoles) || !invitableRoles.every(isInvitableRole) || typeof canManageInvitations !== 'boolean' || typeof canCreateInviteLink !== 'boolean' || typeof canEditShifts !== 'boolean' || typeof canManageBilling !== 'boolean') throw unreadable();
  return { team: { id, name, timeZone }, role, invitableRoles: [...invitableRoles], canManageInvitations, canCreateInviteLink, canEditShifts, canManageBilling };
}

/** A member as GET /teams/:teamId/members lists them. */
export interface Member {
  userId: string;
  name: string;
  role: TeamRole;
}

/** `{ members: [...] }`. Throws if any part cannot be read: half a roster is worse than an error. */
export function parseMembers(body: unknown): Member[] {
  if (!isRecord(body) || !Array.isArray(body.members)) throw unreadable();
  return body.members.map((item) => {
    if (!isRecord(item) || typeof item.userId !== 'string' || typeof item.name !== 'string' || !isRole(item.role)) throw unreadable();
    return { userId: item.userId, name: item.name, role: item.role };
  });
}

/** Personal responses, so the keys carry the user ID (app-state.md): sign-out clears the whole cache, and another account can never read these. */
export const teamDetailQueryKey = (userId: string, teamId: string) => ['team', userId, teamId] as const;
export const membersQueryKey = (userId: string, teamId: string) => ['members', userId, teamId] as const;
