import type { QuietHours } from './service.js';

/**
 * The one place that decides whether a push may be sent now (ADR 0024, ADR 0032, jobs.md "Quiet-hours jobs re-check the user's current settings and time zone
 * when they run"). Pure: no database, no clock of its own, so the tests can walk any moment in any time zone.
 *
 * Quiet hours are wall-clock times in the user's time zone. A window that crosses midnight (22:00 to 06:00) is normal. If the user has not chosen a time zone,
 * the team's is used (ADR 0024); the caller passes it. An `urgent` push is never delayed; nothing is urgent yet (Dave, 2026-11-03), the parameter exists so
 * the decision has one shape when something is.
 *
 * "Send" means "send now". Otherwise `delayUntil` is the next moment the window ends, to the second. A daylight-saving change inside the window can move the
 * real end by an hour; the job decides again when it wakes, so the worst case is one more short delay, never a push inside a window the user set.
 */
export type Decision = { send: true } | { send: false; delayUntil: Date };

export interface DecideInput {
  quietHours: QuietHours;
  /** The user's own IANA time zone, or null if they have not chosen one. */
  timeZone: string | null;
  /** The team's IANA time zone: used when the user has none. */
  fallbackTimeZone: string;
  now: Date;
  urgent: boolean;
}

const HH_MM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function minutesOf(clock: string): number {
  const m = HH_MM.exec(clock);
  if (!m) throw new Error(`quiet hours time must be HH:MM, got "${clock}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The wall-clock minute of the day, and the seconds into that minute, at `now` in `timeZone`. */
function localClock(now: Date, timeZone: string): { minuteOfDay: number; msIntoMinute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error(`could not read the local time in "${timeZone}"`);
  // Every time zone's offset is a whole number of minutes, so the seconds and milliseconds into the minute are the same in UTC.
  return { minuteOfDay: hour * 60 + minute, msIntoMinute: now.getUTCSeconds() * 1000 + now.getUTCMilliseconds() };
}

export function isInQuietWindow(quietHours: QuietHours, minuteOfDay: number): boolean {
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}

export function decide(input: DecideInput): Decision {
  if (input.urgent || !input.quietHours.enabled) return { send: true };
  const timeZone = input.timeZone ?? input.fallbackTimeZone;
  const { minuteOfDay, msIntoMinute } = localClock(input.now, timeZone);
  if (!isInQuietWindow(input.quietHours, minuteOfDay)) return { send: true };
  const end = minutesOf(input.quietHours.end);
  const minutesLeft = (end - minuteOfDay + 1440) % 1440;
  return { send: false, delayUntil: new Date(input.now.getTime() + minutesLeft * 60_000 - msIntoMinute) };
}
