import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import type { Cursor } from './cursor.js';
import { encodeCursor } from './cursor.js';

/**
 * The activity feed (ADR 0022): what happened to a team's shifts, newest first. The rows are written by the shift routes in the same transaction as the
 * change (ADR 0021); this file only reads them. Every query filters by `team_id`.
 *
 * Ordering is `(created_at, id)`, both descending: `created_at` alone would skip or repeat rows that share a timestamp, so the `id` breaks the tie. A page
 * is "the rows strictly older than the cursor". The query asks for one row more than the page, which only tells us whether a next page exists and is never
 * returned. This is the cursor paging the brief asks for: the bookmark is a row, so new activity arriving while someone scrolls cannot shift the pages.
 */
export interface ActivityItem {
  id: string;
  kind: 'shift_created' | 'shift_updated' | 'shift_deleted';
  createdAt: string;
  actor: { id: string; name: string } | null;
  shiftId: string | null;
  /** The snapshot of the shift when it happened, whitelisted: only what the app shows. Null if the stored snapshot cannot be read. */
  shift: { title: string; startsAt: string; endsAt: string } | null;
  /** For an update: the names of the fields that were changed. */
  changed: string[];
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Hand this back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

interface Row {
  id: string;
  created_at: Date;
  actor_user_id: string;
  kind: ActivityItem['kind'];
  shift_id: string | null;
  data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function shiftFrom(data: unknown): ActivityItem['shift'] {
  if (!isRecord(data)) return null;
  const { title, startsAt, endsAt } = data;
  return typeof title === 'string' && typeof startsAt === 'string' && typeof endsAt === 'string' ? { title, startsAt, endsAt } : null;
}

const changedFrom = (data: unknown): string[] =>
  isRecord(data) && Array.isArray(data.changed) ? data.changed.filter((k): k is string => typeof k === 'string') : [];

export async function listActivity(shards: Shards, input: { teamId: string; limit: number; cursor: Cursor | null }): Promise<ActivityPage> {
  const { teamId, limit, cursor } = input;
  const prisma = getShard(shards, teamId).primary;
  const take = limit + 1;
  const rows = cursor
    ? await prisma.$queryRaw<Row[]>`
        SELECT id, created_at, actor_user_id, kind::text AS kind, shift_id, data FROM activity
        WHERE team_id = ${teamId}::uuid AND (created_at, id) < (${cursor.t.toISOString()}::timestamptz, ${cursor.i}::uuid)
        ORDER BY created_at DESC, id DESC LIMIT ${take}`
    : await prisma.$queryRaw<Row[]>`
        SELECT id, created_at, actor_user_id, kind::text AS kind, shift_id, data FROM activity
        WHERE team_id = ${teamId}::uuid
        ORDER BY created_at DESC, id DESC LIMIT ${take}`;

  const page = rows.slice(0, limit);
  const ids = [...new Set(page.map((r) => r.actor_user_id))];
  const users = ids.length === 0 ? [] : await identityDb(shards).user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));

  const items = page.map(
    (r): ActivityItem => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.created_at.toISOString(),
      // An account row that is gone shows as no actor rather than failing the whole page.
      actor: names.has(r.actor_user_id) ? { id: r.actor_user_id, name: names.get(r.actor_user_id)! } : null,
      shiftId: r.shift_id,
      shift: shiftFrom(r.data),
      changed: changedFrom(r.data),
    }),
  );
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at, i: last.id }) : null };
}
