import { ApiError } from '../api/errors';

/** One shift as the server describes it (docs/ARCHITECTURE.md 5d). Server data, never trusted for access: the server checks every request. */
export interface Shift {
  id: string;
  title: string;
  area: string | null;
  startsAt: string;
  endsAt: string;
  breakMinutes: number | null;
  note: string | null;
  assignee: { id: string; name: string } | null;
  status: 'scheduled';
}

const unreadable = () => new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const nullableString = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined);

export function parseShift(value: unknown): Shift | null {
  if (!isRecord(value)) return null;
  const { id, title, startsAt, endsAt, breakMinutes, status } = value;
  const area = nullableString(value.area);
  const note = nullableString(value.note);
  if (typeof id !== 'string' || typeof title !== 'string' || typeof startsAt !== 'string' || typeof endsAt !== 'string') return null;
  if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) return null;
  if (area === undefined || note === undefined || status !== 'scheduled') return null;
  if (breakMinutes !== null && (typeof breakMinutes !== 'number' || !Number.isInteger(breakMinutes))) return null;
  let assignee: Shift['assignee'] = null;
  if (value.assignee !== null) {
    if (!isRecord(value.assignee) || typeof value.assignee.id !== 'string' || typeof value.assignee.name !== 'string') return null;
    assignee = { id: value.assignee.id, name: value.assignee.name };
  }
  return { id, title, area, startsAt, endsAt, breakMinutes: breakMinutes as number | null, note, assignee, status };
}

/** `{ shifts: [...] }`. Throws if any part cannot be read: half a schedule is worse than an error. */
export function parseShiftsList(body: unknown): Shift[] {
  if (!isRecord(body) || !Array.isArray(body.shifts)) throw unreadable();
  return body.shifts.map((item) => {
    const shift = parseShift(item);
    if (!shift) throw unreadable();
    return shift;
  });
}

/** `{ shift }` as create, update and get answer. */
export function parseShiftResponse(body: unknown): Shift {
  const shift = isRecord(body) ? parseShift(body.shift) : null;
  if (!shift) throw unreadable();
  return shift;
}

/**
 * Personal and team data: the keys carry the user ID and the team ID (app-state.md), so sign-out clears them with the rest and another account can never
 * read them. Everything about shifts sits under one prefix so a write can drop every cached range at once.
 */
export const shiftsPrefix = (userId: string, teamId: string) => ['shifts', userId, teamId] as const;
export const shiftsRangeKey = (userId: string, teamId: string, fromIso: string, toIso: string, scope: 'mine' | 'all') =>
  [...shiftsPrefix(userId, teamId), 'range', fromIso, toIso, scope] as const;
export const shiftKey = (userId: string, teamId: string, shiftId: string) => [...shiftsPrefix(userId, teamId), 'one', shiftId] as const;
