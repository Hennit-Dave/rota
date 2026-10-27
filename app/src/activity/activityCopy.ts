/**
 * Every user-facing string of the activity screen. Figma 04: activity 7:88, activity-loading 102:756, activity-loading-more 102:793, activity-empty 102:830,
 * activity-end 102:858, activity-error 102:895. Lines marked "interim" are true today and change when the slice that makes the Figma wording true lands.
 */
export const activityCopy = {
  title: 'Team activity', // 7:93
  subtitle: 'New shifts and shift changes.', // interim: Figma says "New shifts, swaps and shift changes." (swaps are a later slice)
  pullHint: '↓  Pull down to refresh', // 102:694
  loading: 'Loading activity…', // not in Figma: the one announcement for the skeleton rows (Figma 102:648: "announce Loading once for the list")
  loadingMore: 'Loading more', // 102:653
  empty: { title: 'No activity yet', body: 'New shifts and shift changes will show here.' }, // interim: Figma says "New shifts, swaps and shift changes will show here."
  end: { title: 'You’re all caught up', body: 'Pull down to refresh.' }, // 102:858
  error: { title: 'Couldn’t load activity', body: 'Check your connection and try again.', retry: 'Try again' }, // 102:895
  moreFailed: 'Couldn’t load more.', // not in Figma: the next page failed while the rows above are still good
  offline: 'You’re offline. The feed needs a connection.', // not in Figma yet (saved data arrives with the offline slice)
  created: (title: string) => `New shift: ${title}`, // 5:96 "New shift: Morning service"
  updated: (title: string) => `Shift changed: ${title}`, // 5:96 "Shift changed: …"
  deleted: (title: string) => `Shift removed: ${title}`, // not in Figma yet
  createdUntitled: 'New shift',
  updatedUntitled: 'Shift changed',
  deletedUntitled: 'Shift removed',
  today: 'Today',
  yesterday: 'Yesterday',
} as const;
