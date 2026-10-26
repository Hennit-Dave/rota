import type { createApiClient } from '../api/client';
import { parseCreateTeamResponse, parseMembers, parseTeamDetail, parseTeamsList, type Member, type TeamDetail, type TeamSummary } from './teamResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'post'>;

/** The team routes (docs/ARCHITECTURE.md 5a). Plain functions over the API client, so they are unit-tested without a screen. */
export function createTeamApi(client: Client) {
  return {
    /** GET /teams: the teams the caller is in, with the caller's role in each. */
    async listTeams(signal?: AbortSignal): Promise<TeamSummary[]> {
      return parseTeamsList(await client.get<unknown>('/teams', { signal }));
    },
    /** GET /teams/:teamId: the team, the caller's role, and what the caller may do (the roles they can invite, whether they manage invitations). */
    async getTeam(teamId: string, signal?: AbortSignal): Promise<TeamDetail> {
      return parseTeamDetail(await client.get<unknown>(`/teams/${encodeURIComponent(teamId)}`, { signal }));
    },
    /** GET /teams/:teamId/members: everyone on the team. A stranger to the team gets a 404, never a 403 (security.md). */
    async listMembers(teamId: string, signal?: AbortSignal): Promise<Member[]> {
      return parseMembers(await client.get<unknown>(`/teams/${encodeURIComponent(teamId)}/members`, { signal }));
    },
    /** POST /teams: the caller becomes the Owner. The server generates the team ID. */
    async createTeam(input: { name: string; timeZone: string }): Promise<TeamSummary> {
      return parseCreateTeamResponse(await client.post<unknown>('/teams', { name: input.name.trim(), timeZone: input.timeZone }));
    },
  };
}
