import { useQuery } from '@tanstack/react-query';
import { getTeamApi } from '../services';
import { membersQueryKey, teamDetailQueryKey } from './teamResponses';

/**
 * What the signed-in person can do in a team, and who is in it. Server data, personal, so the keys carry the user ID (app-state.md).
 * TanStack's defaults (stale at once, refetched on mount and when the app returns to the foreground): a roster changes whenever someone joins,
 * so no number is invented here (docs/STATE.md). `networkMode: 'always'` so that offline the request fails at once with the offline state instead
 * of pausing for ever with a spinner (the same trap as the invitation preview).
 */
export function useTeamDetail(userId: string | undefined, teamId: string | null) {
  return useQuery({
    queryKey: teamDetailQueryKey(userId ?? '', teamId ?? ''),
    enabled: userId !== undefined && teamId !== null,
    networkMode: 'always',
    queryFn: ({ signal }) => getTeamApi().getTeam(teamId as string, signal),
  });
}

export function useMembers(userId: string | undefined, teamId: string | null) {
  return useQuery({
    queryKey: membersQueryKey(userId ?? '', teamId ?? ''),
    enabled: userId !== undefined && teamId !== null,
    networkMode: 'always',
    queryFn: ({ signal }) => getTeamApi().listMembers(teamId as string, signal),
  });
}
