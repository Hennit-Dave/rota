import type { QueryClient } from '@tanstack/react-query';
import { teamsQueryKey, type TeamSummary } from '../teams/teamResponses';

/**
 * The invitation was accepted (or the caller already had it): make the team the app shows. The brief says the invitee "lands in the
 * right team", so the accepted team goes into the teams list FROM THE ACCEPT ANSWER and is selected, whatever other teams the person
 * is in. Then the list is refetched so the server's version replaces the seed. Without the seed, the home screen's own selection
 * rule (keep the choice only while the list has it) would move the selection to the person's first team.
 */
export function applyAcceptedTeam(
  deps: { queryClient: QueryClient; userId: string | undefined; selectTeam(teamId: string | null): void },
  team: TeamSummary,
): void {
  const { queryClient, userId, selectTeam } = deps;
  if (userId) {
    queryClient.setQueryData<TeamSummary[]>(teamsQueryKey(userId), (previous) => [...(previous ?? []).filter((t) => t.id !== team.id), team]);
    // 'all': the home screen's teams query may have no observer right now, and it never refetches on mount (useTeams).
    void queryClient.invalidateQueries({ queryKey: teamsQueryKey(userId), refetchType: 'all' });
  }
  selectTeam(team.id);
}
