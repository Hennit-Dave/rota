import type { createApiClient } from '../api/client';
import { parseActivityPage, type ActivityPage } from './activityResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get'>;

/** The feed route (docs/ARCHITECTURE.md 5e). Plain functions over the API client, so they are unit-tested without a screen. */
export function createActivityApi(client: Client) {
  return {
    /**
     * GET /teams/:teamId/activity. The team is in the path, the server decides who may read. `cursor` is whatever the previous page's `nextCursor` was,
     * passed back unchanged (it is base64url, safe in a URL as it is, but still encoded). No `limit` means the server's default page.
     */
    async list(teamId: string, page: { cursor?: string | null; limit?: number }, signal?: AbortSignal): Promise<ActivityPage> {
      const query: string[] = [];
      if (page.limit !== undefined) query.push(`limit=${page.limit}`);
      if (page.cursor) query.push(`cursor=${encodeURIComponent(page.cursor)}`);
      const path = `/teams/${encodeURIComponent(teamId)}/activity${query.length ? `?${query.join('&')}` : ''}`;
      return parseActivityPage(await client.get<unknown>(path, { signal }));
    },
  };
}
