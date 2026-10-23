import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getTeamApi } from '../services';
import { useSessionStore } from '../state/sessionStore';
import { pickSelectedTeamId, teamsQueryKey } from './teamResponses';

/**
 * The caller's teams (GET /teams) and the selected team. Personal data, so the key carries the user ID (app-state.md). Whenever the
 * server's list arrives, the selection is kept if the server still lists that team, otherwise it moves to the first one (or none).
 * The selection is not persisted: it is rebuilt from this list on every launch (docs/STATE.md).
 */
export function useTeams(userId: string | undefined) {
  const query = useQuery({
    queryKey: teamsQueryKey(userId ?? ''),
    enabled: userId !== undefined,
    queryFn: ({ signal }) => getTeamApi().listTeams(signal),
    // Same as ['me']: refetched on foreground by the focus manager, not on every visit to a screen.
    refetchOnMount: false,
  });

  const teams = query.data;
  useEffect(() => {
    if (!teams) return;
    const { selectedTeamId, selectTeam } = useSessionStore.getState();
    const next = pickSelectedTeamId(teams, selectedTeamId);
    if (next !== selectedTeamId) selectTeam(next);
  }, [teams]);

  return query;
}
