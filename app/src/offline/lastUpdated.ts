import { dayKeyOf, formatLongDate, formatTime } from '../shifts/shiftTime';
import type { SavedShift } from './upcoming';

/** "Tuesday, 4 March, 14:05" in the team's wall clock, from the SERVER's time (`asOf`). A time that cannot be read gives null, and the screen says nothing rather than guess. */
export function formatLastUpdated(asOf: string, timeZone: string): string | null {
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) return null;
  return `${formatLongDate(dayKeyOf(at, timeZone))}, ${formatTime(at, timeZone)}`;
}

export interface SavedDay {
  key: string;
  shifts: SavedShift[];
}

/**
 * What the offline screen lists: the shifts that have not ended by the phone's clock NOW (so a shift that finished while the phone was offline drops off
 * the list), soonest first, grouped by the day each starts on in the team's time zone.
 */
export function upcomingDays(shifts: readonly SavedShift[], now: Date, timeZone: string): SavedDay[] {
  const days = new Map<string, SavedShift[]>();
  const sorted = shifts
    .filter((s) => Date.parse(s.endsAt) > now.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  for (const shift of sorted) {
    const key = dayKeyOf(new Date(shift.startsAt), timeZone);
    days.set(key, [...(days.get(key) ?? []), shift]);
  }
  return [...days].map(([key, list]) => ({ key, shifts: list }));
}
