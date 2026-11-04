import { ApiError } from '../api/errors';

/**
 * What the phone keeps for offline viewing (ADR 0034, app-state.md "Offline upcoming shifts"): the signed-in person's OWN upcoming shifts for the selected team, the
 * team's name and time zone (the times are the team's wall clock), and `asOf`, the SERVER's clock when it answered, which is what "last updated" shows.
 * Personal information, so only the fields the offline screen draws are kept: the server sends more (a note, a break, the assignee) and the parser drops it
 * at the door, before anything can be saved.
 */
export interface SavedShift {
  id: string;
  title: string;
  area: string | null;
  startsAt: string;
  endsAt: string;
}

export interface Upcoming {
  /** The server's time when it answered (ISO 8601). */
  asOf: string;
  team: { name: string; timeZone: string };
  shifts: SavedShift[];
}

/** The ONLY query root that is ever persisted (`offlineSaving.ts`). */
export const UPCOMING_ROOT = 'upcoming-shifts';
export const upcomingKey = (userId: string, teamId: string) => [UPCOMING_ROOT, userId, teamId] as const;
export type UpcomingKey = ReturnType<typeof upcomingKey>;

const unreadable = () => new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const validInstant = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function parseSavedShift(value: unknown): SavedShift | null {
  if (!isRecord(value)) return null;
  const { id, title, area, startsAt, endsAt } = value;
  if (typeof id !== 'string' || typeof title !== 'string' || !validInstant(startsAt) || !validInstant(endsAt)) return null;
  if (area !== null && typeof area !== 'string') return null;
  return { id, title, area, startsAt, endsAt };
}

/** `{ asOf, team: { name, timeZone }, shifts: [...] }`. Throws if any part cannot be read: half a schedule is worse than an error. */
export function parseUpcoming(body: unknown): Upcoming {
  if (!isRecord(body) || !validInstant(body.asOf) || !isRecord(body.team) || !Array.isArray(body.shifts)) throw unreadable();
  const { name, timeZone } = body.team;
  if (typeof name !== 'string' || typeof timeZone !== 'string') throw unreadable();
  // A time zone this phone cannot use would crash every time on screen: refuse it here, as unreadable, instead.
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    throw unreadable();
  }
  const shifts = body.shifts.map((item) => {
    const shift = parseSavedShift(item);
    if (!shift) throw unreadable();
    return shift;
  });
  return { asOf: body.asOf, team: { name, timeZone }, shifts };
}
