import type { Member, TeamDetail } from './teamResponses';

/** True when the team has no one but the person looking: Figma's "Invite your first team member" card (103:2521) appears under them. */
export function showEmptyTeamCard(members: readonly Member[], myUserId: string | undefined): boolean {
  return members.length === 0 || (members.length === 1 && members[0]!.userId === myUserId);
}

/** "Invite a teammate" shows only when the server says this person may invite someone (Figma note 292:1028). The app decides nothing. */
export function canInvite(detail: TeamDetail | undefined): boolean {
  return detail !== undefined && detail.invitableRoles.length > 0;
}

export type DirectoryStatus = 'ready' | 'loading' | 'failed' | 'no_team';

/**
 * What the Team screen shows before it has a roster. The screen needs a selected team, and that comes from the team list at launch. If the list
 * could not be loaded there is no team to ask about, so the roster and permission queries stay off: without this case the screen waited for ever.
 * - a roster is there: `ready`
 * - no team selected, and the list loaded EMPTY: `no_team` (Home takes the person to Create team)
 * - no team selected, and the list (or the "who am I" answer it waits for) failed: `failed` (error state with Try again)
 * - no team selected yet, list still loading or the selection about to be made: `loading`
 * - a team selected: `failed` if the roster or the permission answer failed, else `loading`
 */
export function directoryStatus(input: {
  teamId: string | null;
  teams: { isError: boolean; count: number | undefined };
  /** "Who am I" failed: the team list is asked for only once the user is known, so it never started. */
  meFailed: boolean;
  hasMembers: boolean;
  membersFailed: boolean;
  detailFailed: boolean;
}): DirectoryStatus {
  if (input.hasMembers) return 'ready';
  if (input.teamId === null) {
    if (input.teams.count === 0) return 'no_team';
    return input.teams.isError || input.meFailed ? 'failed' : 'loading';
  }
  return input.membersFailed || input.detailFailed ? 'failed' : 'loading';
}
