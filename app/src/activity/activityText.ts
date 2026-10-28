import { activityCopy } from './activityCopy';
import type { ActivityItem } from './activityResponses';
import { addDays, dayKeyOf, formatLongDate, formatTime } from '../shifts/shiftTime';

/**
 * "New shift: Morning service", "Shift changed: Morning service", "Shift removed: Morning service", and for swaps "Swap approved for Friday" (Figma 5:96): the
 * weekday of the shift the requester offered, on the team's calendar. A row whose snapshot cannot be read still says what kind of change it was.
 */
export function activityLabel(item: Pick<ActivityItem, 'kind' | 'shift'>, timeZone: string): string {
  const title = item.shift?.title;
  const day = item.shift ? formatLongDate(dayKeyOf(new Date(item.shift.startsAt), timeZone)).split(',')[0] : undefined;
  switch (item.kind) {
    case 'swap_requested':
      return day ? activityCopy.swapRequested(day) : activityCopy.swapRequestedUntitled;
    case 'swap_approved':
      return day ? activityCopy.swapApproved(day) : activityCopy.swapApprovedUntitled;
    case 'swap_rejected':
      return day ? activityCopy.swapRejected(day) : activityCopy.swapRejectedUntitled;
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
