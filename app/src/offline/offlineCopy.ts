/** Every user-facing string of the saved-shifts view. No Figma frame yet: these follow the schedule's wording and are listed in the pull request. */
export const offlineCopy = {
  title: 'Your upcoming shifts',
  subtitle: 'Saved on this phone',
  offline: 'You’re offline. These are your saved shifts.',
  unreachable: 'Rota can’t be reached. These are your saved shifts.',
  lastUpdated: (when: string) => `Last updated ${when}`,
  empty: { title: 'No upcoming shifts saved', body: 'You had no upcoming shifts the last time this phone got your schedule.' },
  retry: 'Try again',
} as const;
