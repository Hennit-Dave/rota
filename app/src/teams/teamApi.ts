import type { createApiClient } from '../api/client';
import { parseCreateTeamResponse, parseTeamsList, type TeamSummary } from './teamResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'post'>;

/** The team routes (docs/ARCHITECTURE.md 5a). Plain functions over the API client, so they are unit-tested without a screen. */
export function createTeamApi(client: Client) {
  return {
    /** GET /teams: the teams the caller is in, with the caller's role in each. */
    async listTeams(signal?: AbortSignal): Promise<TeamSummary[]> {
      return parseTeamsList(await client.get<unknown>('/teams', { signal }));
    },
    /** POST /teams: the caller becomes the Owner. The server generates the team ID. */
    async createTeam(input: { name: string; timeZone: string }): Promise<TeamSummary> {
      return parseCreateTeamResponse(await client.post<unknown>('/teams', { name: input.name.trim(), timeZone: input.timeZone }));
    },
  };
}
