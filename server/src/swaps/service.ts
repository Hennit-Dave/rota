import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { Prisma, type SwapRequest } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { can, type Role } from '../teams/permissions.js';
import { assertNoOverlap, type Tx } from '../shifts/service.js';
import { approverMayDecide } from './rules.js';

/**
 * Swaps (ADR 0023): a request to exchange the requester's own upcoming shift for a teammate's. A manager decides; on approval the two shifts change hands
 * in ONE transaction. Everything is scoped by `team_id`, and the caller, the counterparty and who may decide are decided here from the database, never
 * from the request.
 */
interface ShiftSnapshot {
  shiftId: string;
  title: string;
  area: string | null;
  startsAt: string;
  endsAt: string;
}
interface Snapshot {
  offered: ShiftSnapshot;
  requested: ShiftSnapshot;
}

export interface SwapView {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  decidedAt: string | null;
  requester: { id: string; name: string };
  counterparty: { id: string; name: string };
  /** What the requester gives and what they receive, as the shifts looked when it was requested. */
  offered: Omit<ShiftSnapshot, 'shiftId'> & { shiftId: string };
  requested: Omit<ShiftSnapshot, 'shiftId'> & { shiftId: string };
  /** The caller is the one who asked. */
  mine: boolean;
  /** The server's answer to "may this caller cancel / decide it now": the app shows buttons accordingly, and the server checks again on the action. */
  canCancel: boolean;
  canDecide: boolean;
}

interface LockedSwap {
  id: string;
  team_id: string;
  requester_user_id: string;
  counterparty_user_id: string;
  offered_shift_id: string;
  requested_shift_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  snapshot: unknown;
}
interface LockedSwapView {
  id: string;
  teamId: string;
  offeredShiftId: string;
}
interface LockedShift {
  id: string;
  assigned_user_id: string | null;
  starts_at: Date;
  ends_at: Date;
}

interface Caller {
  userId: string;
  role: Role;
}

async function approverIdsOf(db: { membership: { findMany: Tx['membership']['findMany'] } }, teamId: string): Promise<string[]> {
  const rows = await db.membership.findMany({ where: { teamId, role: { in: ['owner', 'manager'] } }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

async function namesFor(shards: Shards, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const users = await identityDb(shards).user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

function view(row: SwapRequest, names: Map<string, string>, caller: Caller, approverIds: readonly string[]): SwapView {
  const snap = row.snapshot as unknown as Snapshot;
  const pending = row.status === 'pending';
  const mayDecide =
    pending &&
    can(caller.role, 'swaps.approve') &&
    approverMayDecide({
      callerId: caller.userId,
      callerRole: caller.role,
      requesterId: row.requesterUserId,
      counterpartyId: row.counterpartyUserId,
      approverIds,
    });
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    // A member whose account row is gone shows with an empty name rather than failing the whole list.
    requester: { id: row.requesterUserId, name: names.get(row.requesterUserId) ?? '' },
    counterparty: { id: row.counterpartyUserId, name: names.get(row.counterpartyUserId) ?? '' },
    offered: snap.offered,
    requested: snap.requested,
    mine: row.requesterUserId === caller.userId,
    canCancel: pending && row.requesterUserId === caller.userId,
    canDecide: mayDecide,
  };
}

async function viewOne(shards: Shards, row: SwapRequest, caller: Caller): Promise<SwapView> {
  const prisma = getShard(shards, row.teamId).primary;
  const [names, approverIds] = await Promise.all([namesFor(shards, [row.requesterUserId, row.counterpartyUserId]), approverIdsOf(prisma, row.teamId)]);
  return view(row, names, caller, approverIds);
}

const shiftSnapshot = (s: { id: string; title: string; area: string | null; startsAt: Date; endsAt: Date }): ShiftSnapshot => ({
  shiftId: s.id,
  title: s.title,
  area: s.area,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
});

/** The caller's requests and the ones they are the other side of; for someone who may decide swaps, also every request waiting for a decision. Newest first. */
export async function listSwaps(shards: Shards, input: { teamId: string; caller: Caller; limit: number }): Promise<SwapView[]> {
  const { teamId, caller, limit } = input;
  const prisma = getShard(shards, teamId).primary;
  const involved = [{ requesterUserId: caller.userId }, { counterpartyUserId: caller.userId }];
  const rows = await prisma.swapRequest.findMany({
    where: { teamId, OR: can(caller.role, 'swaps.approve') ? [...involved, { status: 'pending' }] : involved },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  const [names, approverIds] = await Promise.all([namesFor(shards, rows.flatMap((r) => [r.requesterUserId, r.counterpartyUserId])), approverIdsOf(prisma, teamId)]);
  return rows.map((r) => view(r, names, caller, approverIds));
}

/** One request, visible to the people in it and to anyone who may decide swaps; everyone else gets the same "not found" as for a request that does not exist. */
export async function getSwap(shards: Shards, input: { teamId: string; swapId: string; caller: Caller }): Promise<SwapView> {
  const row = await getShard(shards, input.teamId).primary.swapRequest.findFirst({ where: { id: input.swapId, teamId: input.teamId } });
  const visible =
    row && (row.requesterUserId === input.caller.userId || row.counterpartyUserId === input.caller.userId || can(input.caller.role, 'swaps.approve'));
  if (!row || !visible) throw new ApiError('not_found', { reason: 'swap_not_found' });
  return viewOne(shards, row, input.caller);
}

/**
 * How long a transaction may wait to START: Prisma's own default (2 s) is too short for a database that has gone to sleep, which is why the auth code sets 5 s
 * (`AUTH_TRANSACTION_MAX_WAIT_MS`); the routes pass that same configured value.
 */
const DEFAULT_MAX_WAIT_MS = 5000;

const invalid = (details: Array<{ path: string; code: string }>) => new ApiError('validation_failed', { details });

/**
 * Ask to swap `offeredShiftId` (the caller's own) for `requestedShiftId` (a teammate's). Returns the request, and whether this call created it: a repeat of
 * the same `Idempotency-Key` (a retry after a timeout) returns the stored request and creates nothing.
 */
export async function createSwap(
  shards: Shards,
  input: { teamId: string; caller: Caller; idempotencyKey: string; offeredShiftId: string; requestedShiftId: string; maxPending: number; now?: Date; maxWaitMs?: number },
): Promise<{ swap: SwapView; created: boolean }> {
  const { teamId, caller, idempotencyKey, offeredShiftId, requestedShiftId, maxPending } = input;
  const now = input.now ?? new Date();
  const prisma = getShard(shards, teamId).primary;

  /** The stored request for this key, if there is one. The same key with a different request is a client bug, not a retry: refuse it. */
  const stored = async (db: Pick<Tx, 'swapRequest'>): Promise<SwapRequest | null> => {
    const existing = await db.swapRequest.findUnique({
      where: { teamId_requesterUserId_idempotencyKey: { teamId, requesterUserId: caller.userId, idempotencyKey } },
    });
    if (existing && (existing.offeredShiftId !== offeredShiftId || existing.requestedShiftId !== requestedShiftId)) {
      throw invalid([{ path: 'header.idempotency-key', code: 'key_reused' }]);
    }
    return existing;
  };
  const replay = async (): Promise<{ swap: SwapView; created: false } | null> => {
    const existing = await stored(prisma);
    return existing ? { swap: await viewOne(shards, existing, caller), created: false } : null;
  };

  const again = await replay();
  if (again) return again;

  try {
    const made = await prisma.$transaction(async (tx) => {
      // Two requests from the same person queue here, so "at most N waiting" is exact (advisory locks are not available through the pooler, data.md).
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM memberships WHERE team_id = ${teamId}::uuid AND user_id = ${caller.userId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new ApiError('not_found', { reason: 'not_a_member' });

      // Looked at AGAIN now that this person's requests are queued: a retry that raced the original waits here, and must get the original back, not run
      // into "this shift is already in a swap" (which the original just made true).
      const already = await stored(tx);
      if (already) return { row: already, created: false };

      const shifts = await tx.shift.findMany({ where: { teamId, id: { in: [offeredShiftId, requestedShiftId] } } });
      const offered = shifts.find((s) => s.id === offeredShiftId);
      const requested = shifts.find((s) => s.id === requestedShiftId);

      // What is wrong is said per field and never reveals more than "not available to swap": a shift of another team, an unknown one, an open one and one
      // that is the caller's own all read the same on the requested side.
      const problems: Array<{ path: string; code: string }> = [];
      if (offeredShiftId === requestedShiftId) problems.push({ path: 'requestedShiftId', code: 'not_swappable' });
      if (!offered || offered.assignedUserId !== caller.userId) problems.push({ path: 'offeredShiftId', code: 'not_yours' });
      else if (offered.startsAt.getTime() <= now.getTime()) problems.push({ path: 'offeredShiftId', code: 'in_past' });
      if (offeredShiftId !== requestedShiftId) {
        if (!requested || requested.assignedUserId === null || requested.assignedUserId === caller.userId) problems.push({ path: 'requestedShiftId', code: 'not_swappable' });
        else if (requested.startsAt.getTime() <= now.getTime()) problems.push({ path: 'requestedShiftId', code: 'in_past' });
      }
      if (problems.length > 0 || !offered || !requested || requested.assignedUserId === null) throw invalid(problems);
      const counterpartyId = requested.assignedUserId;

      const busy = await tx.swapRequest.findFirst({
        where: {
          teamId,
          status: 'pending',
          OR: [{ offeredShiftId: { in: [offeredShiftId, requestedShiftId] } }, { requestedShiftId: { in: [offeredShiftId, requestedShiftId] } }],
        },
        select: { id: true },
      });
      if (busy) throw new ApiError('swap_not_possible', { reason: 'shift_already_in_a_swap', details: [{ path: 'swap', code: 'already_in_swap' }] });

      const waiting = await tx.swapRequest.count({ where: { teamId, requesterUserId: caller.userId, status: 'pending' } });
      if (waiting >= maxPending) throw new ApiError('swap_limit_reached', { reason: 'too_many_pending' });

      // A swap that would double-book either person is refused now, not discovered at approval (the approval checks again).
      await overlapOrThrow(tx, { teamId, userId: caller.userId, startsAt: requested.startsAt, endsAt: requested.endsAt, exceptShiftId: offeredShiftId });
      await overlapOrThrow(tx, { teamId, userId: counterpartyId, startsAt: offered.startsAt, endsAt: offered.endsAt, exceptShiftId: requestedShiftId });

      const snapshot: Snapshot = { offered: shiftSnapshot(offered), requested: shiftSnapshot(requested) };
      const created = await tx.swapRequest.create({
        data: {
          teamId,
          requesterUserId: caller.userId,
          counterpartyUserId: counterpartyId,
          offeredShiftId,
          requestedShiftId,
          idempotencyKey,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.activity.create({
        data: {
          teamId,
          actorUserId: caller.userId,
          kind: 'swap_requested',
          shiftId: offeredShiftId,
          data: { swapId: created.id, title: offered.title, startsAt: snapshot.offered.startsAt, endsAt: snapshot.offered.endsAt, requestedTitle: requested.title },
        },
      });
      return { row: created, created: true };
    }, { maxWait: input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS });
    return { swap: await viewOne(shards, made.row, caller), created: made.created };
  } catch (error) {
    // Two simultaneous requests with the same key: the database let one insert; the other gets that one back.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await replay();
      if (winner) return winner;
    }
    throw error;
  }
}

async function overlapOrThrow(tx: Tx, input: Parameters<typeof assertNoOverlap>[1]): Promise<void> {
  try {
    await assertNoOverlap(tx, input);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'shift_overlap') {
      throw new ApiError('swap_not_possible', { reason: 'would_double_book', details: [{ path: 'swap', code: 'would_double_book' }] });
    }
    throw error;
  }
}

/** The requester withdraws a request that is still waiting. */
export async function cancelSwap(shards: Shards, input: { teamId: string; swapId: string; caller: Caller }): Promise<SwapView> {
  const { teamId, swapId, caller } = input;
  const prisma = getShard(shards, teamId).primary;
  const existing = await prisma.swapRequest.findFirst({ where: { id: swapId, teamId } });
  if (!existing) throw new ApiError('not_found', { reason: 'swap_not_found' });
  if (existing.requesterUserId !== caller.userId) throw new ApiError('forbidden', { reason: 'only_the_requester_may_cancel' });
  // Conditional on the status, so a decision that lands at the same moment wins and the cancel is refused.
  const done = await prisma.swapRequest.updateMany({ where: { id: swapId, teamId, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date(), decidedByUserId: caller.userId } });
  if (done.count === 0) throw new ApiError('swap_not_pending', { reason: 'already_decided' });
  const row = await prisma.swapRequest.findFirstOrThrow({ where: { id: swapId, teamId } });
  return viewOne(shards, row, caller);
}

/**
 * Approve or reject a waiting request, in one transaction. Approval locks the request, then both people's membership rows, then both shifts, and checks
 * everything again against the live rows (the shifts still belong to who they did, at the times they had, still in the future, and neither person ends up
 * double-booked); only then do the two shifts change hands. A request that is no longer possible stays pending, so a manager can reject it.
 */
export async function decideSwap(
  shards: Shards,
  input: { teamId: string; swapId: string; caller: Caller; decision: 'approve' | 'reject'; now?: Date; maxWaitMs?: number },
): Promise<SwapView> {
  const { teamId, swapId, caller, decision } = input;
  const now = input.now ?? new Date();
  const prisma = getShard(shards, teamId).primary;

  const row = await prisma.$transaction(async (tx) => {
    // Locked and read in ONE statement (each round trip to the database costs time, and this transaction is the longest).
    const found = await tx.$queryRaw<LockedSwap[]>`
      SELECT id, team_id, requester_user_id, counterparty_user_id, offered_shift_id, requested_shift_id, status::text AS status, snapshot
      FROM swap_requests WHERE id = ${swapId}::uuid AND team_id = ${teamId}::uuid FOR UPDATE`;
    const locked1 = found[0];
    if (!locked1) throw new ApiError('not_found', { reason: 'swap_not_found' });
    const swap = {
      id: locked1.id,
      teamId: locked1.team_id,
      requesterUserId: locked1.requester_user_id,
      counterpartyUserId: locked1.counterparty_user_id,
      offeredShiftId: locked1.offered_shift_id,
      requestedShiftId: locked1.requested_shift_id,
      status: locked1.status,
      snapshot: locked1.snapshot,
    };
    if (swap.status !== 'pending') throw new ApiError('swap_not_pending', { reason: `already_${swap.status}` });

    const approverIds = await approverIdsOf(tx, teamId);
    if (!approverMayDecide({ callerId: caller.userId, callerRole: caller.role, requesterId: swap.requesterUserId, counterpartyId: swap.counterpartyUserId, approverIds })) {
      throw new ApiError('forbidden', { reason: 'a_party_to_the_swap_may_not_decide_it' });
    }
    const snap = swap.snapshot as unknown as Snapshot;

    if (decision === 'reject') {
      const updated = await tx.swapRequest.update({ where: { id: swapId }, data: { status: 'rejected', decidedAt: now, decidedByUserId: caller.userId } });
      await writeActivity(tx, 'swap_rejected', swap, caller.userId, snap);
      return updated;
    }

    // Both people's membership rows, in a fixed order so two approvals cannot deadlock, then both shifts.
    const people = [swap.requesterUserId, swap.counterpartyUserId].sort();
    const members = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM memberships WHERE team_id = ${teamId}::uuid AND user_id IN (${people[0]}::uuid, ${people[1]}::uuid) ORDER BY user_id FOR UPDATE`;
    if (members.length !== 2) throw new ApiError('swap_not_possible', { reason: 'someone_left_the_team', details: [{ path: 'swap', code: 'someone_left' }] });

    const rows = await tx.$queryRaw<LockedShift[]>`
      SELECT id, assigned_user_id, starts_at, ends_at FROM shifts
      WHERE team_id = ${teamId}::uuid AND id IN (${swap.offeredShiftId}::uuid, ${swap.requestedShiftId}::uuid) ORDER BY id FOR UPDATE`;
    const pick = (id: string) => {
      const r = rows.find((x) => x.id === id);
      return r ? { id: r.id, assignedUserId: r.assigned_user_id, startsAt: r.starts_at, endsAt: r.ends_at } : null;
    };
    const offered = pick(swap.offeredShiftId);
    const requested = pick(swap.requestedShiftId);
    const changed = (err: string) => new ApiError('swap_not_possible', { reason: err, details: [{ path: 'swap', code: 'shift_changed' }] });
    if (!offered || !requested) throw changed('a_shift_no_longer_exists');
    if (offered.assignedUserId !== swap.requesterUserId || requested.assignedUserId !== swap.counterpartyUserId) throw changed('a_shift_changed_hands');
    if (offered.startsAt.toISOString() !== snap.offered.startsAt || offered.endsAt.toISOString() !== snap.offered.endsAt) throw changed('a_shift_was_rescheduled');
    if (requested.startsAt.toISOString() !== snap.requested.startsAt || requested.endsAt.toISOString() !== snap.requested.endsAt) throw changed('a_shift_was_rescheduled');
    if (offered.startsAt.getTime() <= now.getTime() || requested.startsAt.getTime() <= now.getTime()) throw changed('a_shift_has_started');

    await overlapOrThrow(tx, { teamId, userId: swap.requesterUserId, startsAt: requested.startsAt, endsAt: requested.endsAt, exceptShiftId: offered.id });
    await overlapOrThrow(tx, { teamId, userId: swap.counterpartyUserId, startsAt: offered.startsAt, endsAt: offered.endsAt, exceptShiftId: requested.id });

    await tx.shift.update({ where: { id: offered.id }, data: { assignedUserId: swap.counterpartyUserId } });
    await tx.shift.update({ where: { id: requested.id }, data: { assignedUserId: swap.requesterUserId } });
    const updated = await tx.swapRequest.update({ where: { id: swapId }, data: { status: 'approved', decidedAt: now, decidedByUserId: caller.userId } });
    await writeActivity(tx, 'swap_approved', swap, caller.userId, snap);
    return updated;
  }, { maxWait: input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS });
  return viewOne(shards, row, caller);
}

async function writeActivity(tx: Tx, kind: 'swap_approved' | 'swap_rejected', swap: Pick<LockedSwapView, 'id' | 'teamId' | 'offeredShiftId'>, actorUserId: string, snap: Snapshot): Promise<void> {
  await tx.activity.create({
    data: {
      teamId: swap.teamId,
      actorUserId,
      kind,
      shiftId: swap.offeredShiftId,
      data: { swapId: swap.id, title: snap.offered.title, startsAt: snap.offered.startsAt, endsAt: snap.offered.endsAt, requestedTitle: snap.requested.title },
    },
  });
}
