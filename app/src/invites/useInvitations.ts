import { useQuery } from '@tanstack/react-query';
import { getApi } from '../services';
import { createInviteApi } from './inviteApi';

/** Personal, so the key carries the user ID and the team ID (app-state.md): sign-out clears the whole cache. */
export const invitationsQueryKey = (userId: string, teamId: string) => ['invitations', userId, teamId] as const;

/**
 * The team's pending invitations. Only asked for when the server has said this person may list them (`canManageInvitations`): a Staff member would
 * get a refusal. TanStack's defaults (stale at once, refetched on mount and when the app returns to the foreground): an invitation's email state moves
 * from queued to sent or failed without the app doing anything, so no number is invented here (docs/STATE.md). `networkMode: 'always'`: offline it
 * fails at once into the error state instead of waiting for ever.
 */
export function useInvitations(userId: string | undefined, teamId: string | null, allowed: boolean) {
  return useQuery({
    queryKey: invitationsQueryKey(userId ?? '', teamId ?? ''),
    enabled: userId !== undefined && teamId !== null && allowed,
    networkMode: 'always',
    queryFn: ({ signal }) => createInviteApi(getApi()).listInvitations(teamId as string, signal),
  });
}
