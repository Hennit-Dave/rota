import { useMe } from '../auth/useMe';
import { useSessionStore } from '../state/sessionStore';
import { useTeamDetail } from '../teams/useTeamData';
import { useTeams } from '../teams/useTeams';

/**
 * Who is looking at which team, and what the server says they may do there. Every schedule screen starts here. `canEdit` is the server's `shifts.edit`
 * answer (GET /teams/:teamId); the app shows buttons accordingly and the server decides again on every write.
 */
export function useScheduleContext() {
  const me = useMe();
  const userId = me.data?.id;
  const teamId = useSessionStore((s) => s.selectedTeamId);
  const teams = useTeams(userId);
  const detail = useTeamDetail(userId, teamId);
  return {
    me,
    userId,
    teamId,
    teams,
    detail,
    teamName: detail.data?.team.name ?? teams.data?.find((t) => t.id === teamId)?.name,
    timeZone: detail.data?.team.timeZone,
    canEdit: detail.data?.canEditShifts === true,
  };
}
