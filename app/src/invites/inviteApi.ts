import type { createApiClient } from '../api/client';
import type { TeamSummary } from '../teams/teamResponses';
import { parseAcceptResponse, parseInvitationResponse, parseInvitationsList, parseInvitePreview, type InvitationView, type InvitePreview } from './inviteResponses';
import type { InvitableRole } from '../teams/teamResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'post' | 'request'>;

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
    /**
     * POST /teams/:teamId/invitations. Only the address and the role are sent: the team comes from the path, the inviter from the session, and the
     * server decides whether this person may grant that role (security.md). The email is sent from a background job, never from this request.
     */
    async createInvitation(teamId: string, input: { email: string; role: InvitableRole }): Promise<InvitationView> {
      return parseInvitationResponse(
        await client.post<unknown>(`/teams/${encodeURIComponent(teamId)}/invitations`, { email: input.email.trim(), role: input.role }),
      );
    },
    /** GET /teams/:teamId/invitations: the pending invitations, oldest first, each with the server's email state and what the caller may do with it. */
    async listInvitations(teamId: string, signal?: AbortSignal): Promise<InvitationView[]> {
      return parseInvitationsList(await client.get<unknown>(`/teams/${encodeURIComponent(teamId)}/invitations`, { signal }));
    },
    /** DELETE …/invitations/:id: the link stops working at once (204, no body). The server decides who may revoke what. */
    async revokeInvitation(teamId: string, invitationId: string): Promise<void> {
      await client.request(`/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(invitationId)}`, { method: 'DELETE' });
    },
    /** POST …/resend: the same invitation gets a new link (the old one stops working) and a new email. */
    async resendInvitation(teamId: string, invitationId: string): Promise<InvitationView> {
      return parseInvitationResponse(
        await client.post<unknown>(`/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(invitationId)}/resend`),
      );
    },
    /** Joins the team in the role the invitation holds. Safe to repeat for the same account (the server answers the same again). */
    async accept(token: string): Promise<TeamSummary> {
      return parseAcceptResponse(await client.post<unknown>('/invitations/accept', { token }));
    },
  };
}
