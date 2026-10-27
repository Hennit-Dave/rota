import { ApiError } from '../api/errors';

export type ActivityKind = 'shift_created' | 'shift_updated' | 'shift_deleted';

/** One row of the team's feed as the server describes it (docs/ARCHITECTURE.md 5e). Server data: the app formats it and decides nothing. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  actor: { id: string; name: string } | null;
  shiftId: string | null;
  shift: { title: string; startsAt: string; endsAt: string } | null;
  changed: string[];
}

/** One page: its rows and the cursor for the next page (null on the last). The cursor is opaque: the app hands it back unchanged and never builds one. */
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

const unreadable = () => new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS: readonly string[] = ['shift_created', 'shift_updated', 'shift_deleted'];

export function parseActivityItem(value: unknown): ActivityItem | null {
  if (!isRecord(value)) return null;
  const { id, kind, createdAt, actor, shiftId, shift, changed } = value;
  if (typeof id !== 'string' || typeof kind !== 'string' || !KINDS.includes(kind) || typeof createdAt !== 'string') return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  if (shiftId !== null && typeof shiftId !== 'string') return null;
  if (!Array.isArray(changed) || !changed.every((c) => typeof c === 'string')) return null;
  let parsedActor: ActivityItem['actor'] = null;
  if (actor !== null) {
    if (!isRecord(actor) || typeof actor.id !== 'string' || typeof actor.name !== 'string') return null;
    parsedActor = { id: actor.id, name: actor.name };
  }
  let parsedShift: ActivityItem['shift'] = null;
  if (shift !== null) {
    if (!isRecord(shift) || typeof shift.title !== 'string' || typeof shift.startsAt !== 'string' || typeof shift.endsAt !== 'string') return null;
    parsedShift = { title: shift.title, startsAt: shift.startsAt, endsAt: shift.endsAt };
  }
  return { id, kind: kind as ActivityKind, createdAt, actor: parsedActor, shiftId, shift: parsedShift, changed: [...changed] };
}

/** `{ items, nextCursor }`. Throws if any part cannot be read: half a page is worse than an error. */
export function parseActivityPage(body: unknown): ActivityPage {
  if (!isRecord(body) || !Array.isArray(body.items)) throw unreadable();
  if (body.nextCursor !== null && typeof body.nextCursor !== 'string') throw unreadable();
  const items = body.items.map((raw) => {
    const item = parseActivityItem(raw);
    if (!item) throw unreadable();
    return item;
  });
  return { items, nextCursor: body.nextCursor };
}

/**
 * Personal and team data: the keys carry the user ID and the team ID (app-state.md), so sign-out clears them and another account can never read them.
 * The cursor and the page size are NOT in the key: an infinite query keeps its pages (and their cursors) inside one entry.
 */
export const activityKey = (userId: string, teamId: string) => ['activity', userId, teamId] as const;
