/** Every user-facing string on the Team directory (Figma 05 Team: Team directory 8:181, team-empty 103:2521). Marked where the design has no frame. */
export const teamCopy = {
  homeEntry: 'Team', // the placeholder home's way in until the tab bar exists (Dave, 2026-10-24)
  title: 'Your people',
  subtitle: (team: string, count: number) => `${team} · ${count} active ${count === 1 ? 'member' : 'members'}`,
  emptyTitle: 'Invite your first team member',
  emptyBody: 'Your team will show here once people join.',
  invite: 'Invite a teammate',
  loading: 'Loading your team…', // not in Figma yet
  couldNotLoad: 'We couldn’t load your team.', // not in Figma yet
  retry: 'Try again',
  offlineTitle: 'You’re offline', // not in Figma yet
  offlineBody: 'Connect to the internet to see your team.',
} as const;
