import type { createApiClient } from '../api/client';
import type { TeamSummary } from '../teams/teamResponses';
import { parseAcceptResponse, parseInvitePreview, type InvitePreview } from './inviteResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'post'>;

/**
 * The two invite routes that start from a link (docs/ARCHITECTURE.md 5a). Plain functions over the API client, so they are unit-tested
 * without a screen. Both are POSTs so the token never sits in a URL or an access log. Opening a link only ever calls `preview`,
 * which consumes nothing; `accept` runs only from an explicit tap (security.md).
 */
export function createInviteApi(client: Client) {
  return {
    /**
     * Shows what a link is for. The server uses the session if there is one (`signedIn`), so it can say whether this account is the
     * invited one; with none it is a public request. A bad or expired session is simply "nobody signed in" to the server, so the
     * app treats `account: 'none'` while signed in as "not known" and lets accept decide.
     */
    async preview(token: string, options: { signedIn: boolean; signal?: AbortSignal }): Promise<InvitePreview> {
      return parseInvitePreview(await client.post<unknown>('/invitations/preview', { token }, { auth: options.signedIn, signal: options.signal }));
    },
    /** Joins the team in the role the invitation holds. Safe to repeat for the same account (the server answers the same again). */
    async accept(token: string): Promise<TeamSummary> {
      return parseAcceptResponse(await client.post<unknown>('/invitations/accept', { token }));
    },
  };
}
