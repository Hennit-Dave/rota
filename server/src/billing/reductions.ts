// Reductions at the end of the period (ADR 0029, payments slice P5; money.md "Reductions that leave too many members").
// A decrease moves no money and changes nothing now. The Owner schedules it for the end of the current period, and chooses WHO becomes inactive if the
// team has more active members than the new seat limit. This file only schedules, validates, cancels and checks. APPLYING a reduction (deactivating the
// chosen members, the next period, the charge) is the renewal slice (P6). Nothing here writes the ledger.
import { createHash } from 'node:crypto';
import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { shardFor } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { TerminalJobError, type JobHandler } from '../jobs/worker.js';
import { assess, loadSubscriptionState } from './changes.js';
import { assertValidTarget, lockTeamAndFindPrior, nowOf, requireNoOpenOperation, type BillingDeps, type StoredAnswer } from './checkout.js';
import { PLAN_NAMES } from './display.js';
import { type Entitlements, type PlanId } from './plans.js';
import { FALLBACK_WORDING } from './reductionWording.js';
import { z } from 'zod';
import { CANONICAL_UUID } from '../db/shard.js';

/** available_at = run_at + 2 minutes on normal creation (jobs.md). */
const SWEEP_GRACE_MS = 2 * 60 * 1000;

export interface ActiveMember {
  userId: string;
  role: 'owner' | 'manager' | 'staff';
}

/**
 * Who must be chosen, and whether the choice is valid. Pure. Exactly `needed = max(0, active - target)` distinct, active, non-Owner members:
 * fewer than needed is 422 `selection_required` (the Owner has to choose), anything else wrong is 422 `selection_invalid`.
 */
export function checkSelection(input: { members: ActiveMember[]; targetSeats: number; selected: string[] }): void {
  const needed = Math.max(0, input.members.length - input.targetSeats);
  const selected = input.selected;
  if (new Set(selected).size !== selected.length) throw new ApiError('selection_invalid', { reason: 'duplicate_member' });
  const byId = new Map(input.members.map((m) => [m.userId, m]));
  for (const id of selected) {
    const member = byId.get(id);
    if (!member) throw new ApiError('selection_invalid', { reason: 'not_an_active_member' });
    if (member.role === 'owner') throw new ApiError('selection_invalid', { reason: 'owner_cannot_be_deactivated' });
  }
  if (selected.length < needed) throw new ApiError('selection_required', { reason: `need_${needed}_chosen_${selected.length}` });
  if (selected.length > needed) throw new ApiError('selection_invalid', { reason: `need_${needed}_chosen_${selected.length}` });
}

/** What the boundary check finds. Pure: the members still active after the chosen ones go, against the new limit, and what the Owner accepted. */
export type BoundaryOutcome = 'ready' | 'blocked' | 'continuing';
export function boundaryOutcome(input: { activeAfter: number; targetSeats: number; fallbackAccepted: boolean }): BoundaryOutcome {
  if (input.activeAfter <= input.targetSeats) return 'ready';
  return input.fallbackAccepted ? 'continuing' : 'blocked';
}

export interface ScheduledChangeView {
  id: string;
  status: 'scheduled' | 'ready' | 'blocked' | 'continuing';
  targetPlan: PlanId;
  targetPlanName: string;
  targetSeats: number;
  effectiveOn: string;
  /** The people who will become inactive on that date, by name. */
  membersToDeactivate: Array<{ userId: string; name: string }>;
  fallbackAccepted: boolean;
  fallbackWording: string | null;
  /** A sentence for the Owner, made here. */
  message: string;
  /** True only while the status is `scheduled`: after the boundary check the Owner can no longer cancel (money.md). */
  canCancel: boolean;
}

interface ScheduledRow {
  id: string;
  status: ScheduledChangeView['status'];
  target_plan: PlanId;
  target_seats: number;
  effective_on: string;
  selected: string[];
  fallback_accepted_at: Date | null;
  fallback_wording: string | null;
}

const LIVE = ['scheduled', 'ready', 'blocked', 'continuing'];

function messageFor(row: ScheduledRow): string {
  const to = `${PLAN_NAMES[row.target_plan]}, ${row.target_seats} ${row.target_seats === 1 ? 'seat' : 'seats'}`;
  switch (row.status) {
    case 'scheduled':
      return `Your plan changes to ${to} on ${row.effective_on}. Nothing is charged or refunded now.`;
    case 'ready':
      return `The check passed. Your plan will change to ${to} on ${row.effective_on}.`;
    case 'blocked':
      return `On ${row.effective_on} your team had more active members than ${to} allows, and you did not accept continuing at your current price. The reduction has not been applied and needs your attention.`;
    case 'continuing':
      return `On ${row.effective_on} your team had more active members than ${to} allows. As you accepted when you scheduled this, your current plan and price continue until you fix it.`;
  }
}

/** The team's live scheduled reduction as the Owner sees it, or null. Names come from the identity shard. */
export async function getScheduledChange(shards: Shards, teamId: string): Promise<ScheduledChangeView | null> {
  const prisma = getShard(shards, teamId).primary;
  const rows = await prisma.$queryRaw<ScheduledRow[]>`
    SELECT id::text AS id, status::text AS status, target_plan::text AS target_plan, target_seats, effective_on::text AS effective_on,
      selected_member_ids::text[] AS selected, fallback_accepted_at, fallback_wording
    FROM scheduled_changes WHERE team_id = ${teamId}::uuid AND status::text = ANY(${LIVE}::text[])`;
  const row = rows[0];
  if (!row) return null;
  const users = row.selected.length > 0 ? await identityDb(shards).user.findMany({ where: { id: { in: row.selected } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return {
    id: row.id,
    status: row.status,
    targetPlan: row.target_plan,
    targetPlanName: PLAN_NAMES[row.target_plan],
    targetSeats: row.target_seats,
    effectiveOn: row.effective_on,
    membersToDeactivate: row.selected.map((userId) => ({ userId, name: nameOf.get(userId) ?? 'Former member' })),
    fallbackAccepted: row.fallback_accepted_at !== null,
    fallbackWording: row.fallback_wording,
    message: messageFor(row),
    canCancel: row.status === 'scheduled',
  };
}

function fingerprintOf(plan: PlanId, seats: number, selected: string[], acceptFallback: boolean): string {
  return createHash('sha256').update(`reduction|${plan}|${seats}|${[...selected].sort().join(',')}|${acceptFallback ? 1 : 0}`, 'utf8').digest('hex');
}

async function activeMembersOf(db: Pick<PrismaClient, '$queryRaw'>, teamId: string): Promise<ActiveMember[]> {
  const rows = await db.$queryRaw<Array<{ user_id: string; role: ActiveMember['role'] }>>`
    SELECT user_id::text AS user_id, role::text AS role FROM memberships WHERE team_id = ${teamId}::uuid AND deactivated_at IS NULL`;
  return rows.map((r) => ({ userId: r.user_id, role: r.role }));
}

export const REDUCTION_BOUNDARY_KIND = 'reduction_boundary';

export const reductionBoundaryPayload = z.object({ teamId: z.string().regex(CANONICAL_UUID), scheduledChangeId: z.string().regex(CANONICAL_UUID) });

/**
 * Schedules a decrease for the end of the current period. One transaction under the team row lock: it re-reads the subscription, refuses while a payment
 * is open, validates the chosen people against the members as they are NOW, stores the Owner's explicit fallback acceptance with its wording and time, and
 * writes the boundary work row. Only after it commits is the job enqueued (rule 9).
 */
export async function scheduleReduction(
  deps: BillingDeps,
  input: { teamId: string; actorUserId: string; idempotencyKey: string; plan: PlanId; seats: number; selectedMemberIds: string[]; acceptFallback: boolean },
): Promise<StoredAnswer> {
  const { teamId } = input;
  const target: Entitlements = { plan: input.plan, seats: input.seats };
  assertValidTarget(target);
  const prisma = getShard(deps.shards, teamId).primary;
  const fingerprint = fingerprintOf(input.plan, input.seats, input.selectedMemberIds, input.acceptFallback);
  const now = nowOf(deps);

  type Step = { kind: 'replay'; status: number; body: unknown } | { kind: 'scheduled'; body: unknown; work: WorkRow };
  const step = await prisma.$transaction(
    async (tx): Promise<Step> => {
      const prior = await lockTeamAndFindPrior(tx, teamId, input.idempotencyKey, fingerprint);
      if (prior.kind === 'replay') return prior;
      if (prior.kind !== 'new') throw new ApiError('internal_error', { reason: 'unexpected_prior_request' });

      const state = await loadSubscriptionState(tx, teamId, true);
      if (!state) throw new ApiError('not_activated');
      await requireNoOpenOperation(tx, teamId);
      const { quote, period } = assess(state, target, now);
      if (quote.kind === 'none') throw new ApiError('validation_failed', { details: [{ path: 'plan', code: 'nothing_to_change' }] });
      if (quote.kind !== 'scheduled_only') throw new ApiError('scheduled_change_unavailable');

      const live = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM scheduled_changes WHERE team_id = ${teamId}::uuid AND status::text = ANY(${LIVE}::text[])`;
      if (live.length > 0) throw new ApiError('reduction_already_scheduled');

      const members = await activeMembersOf(tx, teamId);
      checkSelection({ members, targetSeats: target.seats, selected: input.selectedMemberIds });

      const wording = input.acceptFallback ? FALLBACK_WORDING : null;
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO scheduled_changes (team_id, requested_by_user_id, from_period_id, base_version, from_plan, from_seats, target_plan, target_seats, effective_on,
          selected_member_ids, fallback_accepted_at, fallback_wording)
        VALUES (${teamId}::uuid, ${input.actorUserId}::uuid, ${state.current_period_id}::uuid, ${state.version}, ${state.plan}::billing_plan, ${state.seats},
          ${target.plan}::billing_plan, ${target.seats}, ${period.endsOn}::date, ${input.selectedMemberIds}::uuid[],
          ${input.acceptFallback ? now : null}, ${wording})
        RETURNING id::text AS id`;
      const scheduledChangeId = inserted[0]!.id;

      // The boundary check runs when the period ends: 00:00 UTC on the effective date. available_at = run_at + 2 minutes (jobs.md).
      const runAt = new Date(`${period.endsOn}T00:00:00.000Z`);
      const work = await tx.workRow.create({
        data: {
          kind: REDUCTION_BOUNDARY_KIND,
          payload: { teamId, scheduledChangeId },
          runAt,
          availableAt: new Date(runAt.getTime() + SWEEP_GRACE_MS),
          status: 'pending',
          generation: 1,
          executionAttempts: 0,
        },
      });
      const body = { status: 'scheduled', scheduledChange: { id: scheduledChangeId } };
      await tx.$executeRaw`
        INSERT INTO payment_requests (team_id, user_id, idempotency_key, request_fingerprint, operation_id, response_status, response)
        VALUES (${teamId}::uuid, ${input.actorUserId}::uuid, ${input.idempotencyKey}, ${fingerprint}, NULL, 201, ${JSON.stringify(body)}::jsonb)`;
      return { kind: 'scheduled', body, work };
    },
    { maxWait: deps.maxWaitMs },
  );

  if (step.kind === 'replay') return { status: step.status === 201 ? 200 : step.status, body: step.body, replay: true };
  // Committed. A failed enqueue never fails the request: the row is eligible for the sweep (jobs.md).
  await deps.enqueue?.(prisma, step.work, shardFor(teamId));
  const scheduledChange = await getScheduledChange(deps.shards, teamId);
  return { status: 201, body: { status: 'scheduled', scheduledChange }, replay: false };
}

/** Cancels the team's scheduled reduction. Only while it is `scheduled`: after the boundary check it is no longer the Owner's to take back (money.md). */
export async function cancelReduction(deps: BillingDeps, input: { teamId: string }): Promise<void> {
  const { teamId } = input;
  const prisma = getShard(deps.shards, teamId).primary;
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
      const live = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id::text AS id, status::text AS status FROM scheduled_changes WHERE team_id = ${teamId}::uuid AND status::text = ANY(${LIVE}::text[]) FOR UPDATE`;
      const row = live[0];
      if (!row) throw new ApiError('not_found', { reason: 'no_scheduled_reduction' });
      if (row.status !== 'scheduled') throw new ApiError('scheduled_change_unavailable', { reason: `cannot_cancel_${row.status}` });
      await tx.$executeRaw`UPDATE scheduled_changes SET status = 'cancelled'::scheduled_change_status, updated_at = NOW() WHERE id = ${row.id}::uuid`;
      // The boundary job finds a cancelled change and does nothing; its work row stays (it is an audit of the schedule) and completes as a no-op.
    },
    { maxWait: deps.maxWaitMs },
  );
}

/**
 * The boundary check job (jobs.md). At the period boundary it re-counts the members who would remain and records what it found: `ready` (it fits),
 * `continuing` (it does not fit, and the Owner accepted continuing at the current price) or `blocked` (it does not fit and nothing was accepted).
 * It applies NOTHING: deactivating members, the next period and the charge are the renewal slice (P6). A change that is no longer `scheduled`
 * (cancelled, or already checked) is left alone, so a replay is harmless.
 */
export function createReductionBoundaryHandler(deps: { shards: Shards; logger?: (line: string) => void }): JobHandler {
  const log = deps.logger ?? ((line: string) => console.log(line));
  return async (ctx) => {
    const parsed = reductionBoundaryPayload.safeParse(ctx.row.payload);
    if (!parsed.success) throw new TerminalJobError('invalid_payload');
    const { teamId, scheduledChangeId } = parsed.data;
    const logBase = `[reduction_boundary] row_id=${ctx.row.id} generation=${ctx.row.generation} team_id=${teamId} scheduled_change_id=${scheduledChangeId}`;
    const team = getShard(deps.shards, teamId).primary;

    const outcome = await team.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
      const rows = await tx.$queryRaw<Array<{ status: string; target_seats: number; selected: string[]; fallback_accepted_at: Date | null }>>`
        SELECT status::text AS status, target_seats, selected_member_ids::text[] AS selected, fallback_accepted_at
        FROM scheduled_changes WHERE id = ${scheduledChangeId}::uuid AND team_id = ${teamId}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) return { skipped: 'missing' as const };
      if (row.status !== 'scheduled') return { skipped: row.status };
      const remaining = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM memberships WHERE team_id = ${teamId}::uuid AND deactivated_at IS NULL AND NOT (user_id = ANY(${row.selected}::uuid[]))`;
      const activeAfter = Number(remaining[0]?.n ?? 0);
      const result = boundaryOutcome({ activeAfter, targetSeats: row.target_seats, fallbackAccepted: row.fallback_accepted_at !== null });
      const detail = `active_after_${activeAfter}_target_${row.target_seats}`;
      await tx.$executeRaw`
        UPDATE scheduled_changes SET status = ${result}::scheduled_change_status, checked_at = NOW(), check_detail = ${detail}, updated_at = NOW()
        WHERE id = ${scheduledChangeId}::uuid`;
      return { result, detail };
    });

    if ('skipped' in outcome) {
      log(`${logBase} outcome=skipped detail=${outcome.skipped}`);
      return;
    }
    // The Owner is told in the app (a banner). The push and email notice waits for the push slice (issue #53).
    const line = `${logBase} outcome=${outcome.result} detail=${outcome.detail}`;
    log(outcome.result === 'ready' ? line : `${line} NOTIFY_OWNER_PENDING`);
  };
}
