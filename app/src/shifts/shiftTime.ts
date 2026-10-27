/**
 * Calendar maths in the TEAM'S time zone (ADR 0021). The server stores and sends UTC instants; what "Thursday" and "09:00" mean is the team's wall clock, so
 * every conversion here takes the IANA zone and uses Intl (already in Hermes). A "day key" is `YYYY-MM-DD` in that zone. No arithmetic on money; only time.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What the clock on the wall of `timeZone` reads at this instant. */
export function wallClock(instant: Date, timeZone: string): WallClock {
  const out: Record<string, number> = {};
  for (const p of parts(timeZone).formatToParts(instant)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DD` of this instant on the wall of `timeZone`. */
export function dayKeyOf(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date a day key names, or null if it is not a real date (2031-02-30 is not). */
export function parseDayKey(key: string): { year: number; month: number; day: number } | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
}

/** A day key moved by whole calendar days (pure date arithmetic: it never depends on a zone). */
export function addDays(key: string, days: number): string {
  const p = parseDayKey(key)!;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The offset of `timeZone` from UTC at this instant, in milliseconds (positive east of Greenwich). */
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const w = wallClock(new Date(whole), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
}

/**
 * The instant at which the wall clock of `timeZone` reads this date and time. Two passes settle the offset across a daylight-saving change. A time that
 * does not exist (the clocks jumped over it) lands just after the jump; one that happens twice (the clocks fell back) takes the first.
 */
export function zonedInstant(key: string, hour: number, minute: number, timeZone: string): Date | null {
  const p = parseDayKey(key);
  if (!p || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const naive = Date.UTC(p.year, p.month - 1, p.day, hour, minute);
  let t = naive - offsetAt(naive, timeZone);
  t = naive - offsetAt(t, timeZone);
  return new Date(t);
}

/** Midnight at the start of this day in the zone. */
export function startOfDay(key: string, timeZone: string): Date {
  return zonedInstant(key, 0, 0, timeZone)!;
}

/** Monday to Sunday of the week this day is in. */
export function weekOf(key: string): string[] {
  const p = parseDayKey(key)!;
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday
  const monday = addDays(key, -((dow + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The half-open window `[from, to)` of one week in the zone: what the calendar asks the server for. 7 days, well inside the server's cap. */
export function weekWindow(key: string, timeZone: string): { from: Date; to: Date; days: string[] } {
  const days = weekOf(key);
  return { from: startOfDay(days[0]!, timeZone), to: startOfDay(addDays(days[6]!, 1), timeZone), days };
}

/** `09:00` in the zone (24-hour, as Figma shows it). */
export function formatTime(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** `09:00 – 17:00` (an en dash with spaces, Figma 7:27). */
export function formatRange(start: Date, end: Date, timeZone: string): string {
  return `${formatTime(start, timeZone)} – ${formatTime(end, timeZone)}`;
}

const longDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'narrow' });

/** `Thursday, 15 October` for a day key (Figma 7:12). Built from the parts, because en-GB's own separator differs between ICU versions. */
export function formatLongDate(key: string): string {
  const p = parseDayKey(key)!;
  const out: Record<string, string> = {};
  for (const part of longDate.formatToParts(new Date(Date.UTC(p.year, p.month - 1, p.day)))) if (part.type !== 'literal') out[part.type] = part.value;
  return `${out.weekday}, ${out.day} ${out.month}`;
}

/** The week strip's cell: the first letter of the weekday and the day of the month (Figma 7:14: "M" over "12"). */
export function stripLabel(key: string): { letter: string; day: number } {
  const p = parseDayKey(key)!;
  return { letter: shortDay.format(new Date(Date.UTC(p.year, p.month - 1, p.day))), day: p.day };
}

/** "Good morning", "Good afternoon" or "Good evening" from the hour on the team's wall clock. */
export function greetingFor(instant: Date, timeZone: string): string {
  const hour = wallClock(instant, timeZone).hour;
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Shifts that overlap this day in the zone (a shift that runs past midnight shows on both days), soonest first. */
export function shiftsOnDay<T extends { startsAt: string; endsAt: string; id: string }>(shifts: readonly T[], key: string, timeZone: string): T[] {
  const from = startOfDay(key, timeZone).getTime();
  const to = startOfDay(addDays(key, 1), timeZone).getTime();
  return shifts
    .filter((s) => Date.parse(s.startsAt) < to && Date.parse(s.endsAt) > from)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** `9:00` or `09:00` as hours and minutes, or null. 24-hour only. */
export function parseTime(text: string): { hour: number; minute: number } | null {
  const m = TIME.exec(text.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}
