import { activityCopy } from './activityCopy';
import type { ActivityItem } from './activityResponses';
import { addDays, dayKeyOf, formatLongDate, formatTime } from '../shifts/shiftTime';

/** "New shift: Morning service", "Shift changed: Morning service", "Shift removed: Morning service". A row whose snapshot cannot be read still says what kind of change it was. */
export function activityLabel(item: Pick<ActivityItem, 'kind' | 'shift'>): string {
  const title = item.shift?.title;
  switch (item.kind) {
    case 'shift_created':
      return title ? activityCopy.created(title) : activityCopy.createdUntitled;
    case 'shift_updated':
      return title ? activityCopy.updated(title) : activityCopy.updatedUntitled;
    case 'shift_deleted':
      return title ? activityCopy.deleted(title) : activityCopy.deletedUntitled;
  }
}

/**
 * "Today, 08:42 · Daniel" (Figma 5:97). "Today" and "Yesterday" are counted on the TEAM'S calendar, not the phone's: a row written at 23:30 team time is
 * still "Today" for the whole team. Older rows give the date ("Monday, 26 October, 08:42"). The person is shown by first name, as in Figma; a row whose
 * person's account is gone shows only the time.
 */
export function activityDetail(item: Pick<ActivityItem, 'createdAt' | 'actor'>, now: Date, timeZone: string): string {
  const at = new Date(item.createdAt);
  const day = dayKeyOf(at, timeZone);
  const today = dayKeyOf(now, timeZone);
  const when =
    day === today
      ? activityCopy.today
      : day === addDays(today, -1)
        ? activityCopy.yesterday
        : formatLongDate(day);
  const first = item.actor?.name.trim().split(/\s+/)[0];
  return `${when}, ${formatTime(at, timeZone)}${first ? ` · ${first}` : ''}`;
}
