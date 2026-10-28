import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import type { PrismaClient, Shift } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { timesProblem } from './schemas.js';

/**
 * Shifts and the activity they write (ADR 0021). A shift lives on its team's shard and every query filters by `team_id`: a shift ID from another team is
 * simply not found. Every write is ONE transaction on that shard that changes the shift AND appends its activity row, so the record of what happened
 * can never disagree with what exists. Assignees are users on shard A, so there is no foreign key; the server checks the person is a member of this team.
 */
export interface ShiftView {
  id: string;
  title: string;
  area: string | null;
  startsAt: string;
  endsAt: string;
  breakMinutes: number | null;
  note: string | null;
  assignee: { id: string; name: string } | null;
  /** Every shift is published when it is created (no drafts), so this is always "scheduled". */
  status: 'scheduled';
}

type Names = Map<string, string>;

async function namesFor(shards: Shards, userIds: Array<string | null>): Promise<Names> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const users = await identityDb(shards).user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

function view(row: Shift, names: Names): ShiftView {
  const name = row.assignedUserId ? names.get(row.assignedUserId) : undefined;
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    breakMinutes: row.breakMinutes,
    note: row.note,
    // A member whose account row is gone shows as an open shift rather than failing the whole calendar (logged by the caller's request log).
    assignee: row.assignedUserId && name !== undefined ? { id: row.assignedUserId, name } : null,
    status: 'scheduled',
  };
}

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Lock the assignee's membership row, so two requests that give the same person a shift queue up here (advisory locks are not available through the
 * pooler, data.md). It also proves the assignee is a member of THIS team. Must run before the overlap check, in the same transaction.
 */
async function lockAssignee(tx: Tx, teamId: string, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memberships WHERE team_id = ${teamId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new ApiError('validation_failed', { details: [{ path: 'assignedUserId', code: 'not_a_member' }] });
}

/** A person may not have two shifts that overlap. Shifts that only touch (one ends when the next starts) are fine. */
export async function assertNoOverlap(tx: Tx, input: { teamId: string; userId: string; startsAt: Date; endsAt: Date; exceptShiftId?: string }): Promise<void> {
  const clash = await tx.shift.findFirst({
    where: {
      teamId: input.teamId,
      assignedUserId: input.userId,
      startsAt: { lt: input.endsAt },
      endsAt: { gt: input.startsAt },
      ...(input.exceptShiftId ? { NOT: { id: input.exceptShiftId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new ApiError('shift_overlap', { reason: 'assignee_has_overlapping_shift' });
}

const snapshot = (s: Pick<Shift, 'title' | 'startsAt' | 'endsAt' | 'assignedUserId'>) => ({
  title: s.title,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  assignedUserId: s.assignedUserId,
});

/** Shifts that overlap `[from, to)`, soonest first, with the assignee's name. `assignedUserId` narrows it to one person's shifts. */
export async function listShifts(
  shards: Shards,
  input: { teamId: string; from: Date; to: Date; assignedUserId?: string },
): Promise<ShiftView[]> {
  const rows = await getShard(shards, input.teamId).primary.shift.findMany({
    where: {
      teamId: input.teamId,
      startsAt: { lt: input.to },
      endsAt: { gt: input.from },
      ...(input.assignedUserId ? { assignedUserId: input.assignedUserId } : {}),
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
  const names = await namesFor(shards, rows.map((r) => r.assignedUserId));
  return rows.map((r) => view(r, names));
}

/** One shift, scoped by team: a shift of another team is "not found", the same answer as a shift that does not exist. */
export async function getShift(shards: Shards, input: { teamId: string; shiftId: string }): Promise<ShiftView> {
  const row = await getShard(shards, input.teamId).primary.shift.findFirst({ where: { id: input.shiftId, teamId: input.teamId } });
  if (!row) throw new ApiError('not_found', { reason: 'shift_not_found' });
  return view(row, await namesFor(shards, [row.assignedUserId]));
}

export interface NewShift {
  title: string;
  area?: string;
  startsAt: Date;
  endsAt: Date;
  breakMinutes?: number;
  note?: string;
  assignedUserId?: string | null;
}

export async function createShift(shards: Shards, input: { teamId: string; actorUserId: string; shift: NewShift }): Promise<ShiftView> {
  const { teamId, actorUserId, shift } = input;
  const prisma = getShard(shards, teamId).primary;
  const assignee = shift.assignedUserId ?? null;

  const created = await prisma.$transaction(async (tx) => {
    if (assignee) {
      await lockAssignee(tx, teamId, assignee);
      await assertNoOverlap(tx, { teamId, userId: assignee, startsAt: shift.startsAt, endsAt: shift.endsAt });
    }
    const row = await tx.shift.create({
      data: {
        teamId,
        title: shift.title,
        area: shift.area ?? null,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        breakMinutes: shift.breakMinutes ?? null,
        note: shift.note ?? null,
        assignedUserId: assignee,
        createdByUserId: actorUserId,
      },
    });
    await tx.activity.create({ data: { teamId, actorUserId, kind: 'shift_created', shiftId: row.id, data: snapshot(row) } });
    return row;
  });
  return view(created, await namesFor(shards, [created.assignedUserId]));
}

export interface ShiftPatch {
  title?: string;
  area?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  breakMinutes?: number | null;
  note?: string | null;
  assignedUserId?: string | null;
}

export async function updateShift(shards: Shards, input: { teamId: string; shiftId: string; actorUserId: string; patch: ShiftPatch }): Promise<ShiftView> {
  const { teamId, shiftId, actorUserId, patch } = input;
  const prisma = getShard(shards, teamId).primary;

  const updated = await prisma.$transaction(async (tx) => {
    // Locks this shift's row (scoped by team_id, so another team's shift ID finds nothing) so two edits to it queue up.
    const found = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM shifts WHERE id = ${shiftId}::uuid AND team_id = ${teamId}::uuid FOR UPDATE`;
    if (found.length === 0) throw new ApiError('not_found', { reason: 'shift_not_found' });
    const current = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } });

    const next = {
      title: patch.title ?? current.title,
      area: patch.area === undefined ? current.area : patch.area,
      startsAt: patch.startsAt ?? current.startsAt,
      endsAt: patch.endsAt ?? current.endsAt,
      breakMinutes: patch.breakMinutes === undefined ? current.breakMinutes : patch.breakMinutes,
      note: patch.note === undefined ? current.note : patch.note,
      assignedUserId: patch.assignedUserId === undefined ? current.assignedUserId : patch.assignedUserId,
    };
    // The merged shift must still make sense (a partial update can break the stored shift's own rules).
    const problem = timesProblem(next);
    if (problem) throw new ApiError('validation_failed', { details: [{ path: problem.path, code: problem.code, ...(problem.max !== undefined ? { max: problem.max } : {}) }] });

    if (next.assignedUserId) {
      await lockAssignee(tx, teamId, next.assignedUserId);
      await assertNoOverlap(tx, { teamId, userId: next.assignedUserId, startsAt: next.startsAt, endsAt: next.endsAt, exceptShiftId: shiftId });
    }
    const row = await tx.shift.update({ where: { id: shiftId }, data: next });
    const changed = (Object.keys(patch) as Array<keyof ShiftPatch>).filter((k) => patch[k] !== undefined);
    await tx.activity.create({ data: { teamId, actorUserId, kind: 'shift_updated', shiftId, data: { ...snapshot(row), changed } } });
    return row;
  });
  return view(updated, await namesFor(shards, [updated.assignedUserId]));
}

export async function deleteShift(shards: Shards, input: { teamId: string; shiftId: string; actorUserId: string }): Promise<void> {
  const { teamId, shiftId, actorUserId } = input;
  await getShard(shards, teamId).primary.$transaction(async (tx) => {
    const gone = await tx.shift.findFirst({ where: { id: shiftId, teamId } });
    if (!gone) throw new ApiError('not_found', { reason: 'shift_not_found' });
    // Scoped by team_id again on the delete itself, so the filter is in the statement that matters, not only in the check before it.
    const removed = await tx.shift.deleteMany({ where: { id: shiftId, teamId } });
    if (removed.count === 0) throw new ApiError('not_found', { reason: 'shift_not_found' });
    await tx.activity.create({ data: { teamId, actorUserId, kind: 'shift_deleted', shiftId, data: snapshot(gone) } });
  });
}
