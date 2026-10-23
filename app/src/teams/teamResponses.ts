import { ApiError } from '../api/errors';

export type TeamRole = 'owner' | 'manager' | 'staff';

/** A team the caller is in, as GET /teams and POST /teams answer. Server data, never trusted for access (the server checks every request). */
export interface TeamSummary {
  id: string;
  name: string;
  timeZone: string;
  role: TeamRole;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRole(value: unknown): value is TeamRole {
  return value === 'owner' || value === 'manager' || value === 'staff';
}

function parseSummary(value: unknown): TeamSummary | null {
  if (!isRecord(value)) return null;
  const { id, name, timeZone, role } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof timeZone !== 'string' || !isRole(role)) return null;
  return { id, name, timeZone, role };
}

const unreadable = () => new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);

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
