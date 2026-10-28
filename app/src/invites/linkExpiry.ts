import { dayKeyOf, formatShortDate, formatTime } from '../shifts/shiftTime';

/** "Fri 30 Oct, 14:05": when an invite link stops working, on the team's clock. The instant is the server's `expiresAt`; the app only formats it. */
export function linkExpiryText(expiresAt: string, timeZone: string | undefined): string | null {
  const instant = new Date(expiresAt);
  if (Number.isNaN(instant.getTime()) || timeZone === undefined) return null;
  return `${formatShortDate(dayKeyOf(instant, timeZone))}, ${formatTime(instant, timeZone)}`;
}
