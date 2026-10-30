// Activating a team's subscription (ADR 0027, payments slice P3). The server quotes, freezes a payment operation, and makes the ONE synchronous
// Stripe call (AGENTS.md rule 10): a Checkout Session for an amount our own engine calculated. It never records a payment outcome; only a verified
// webhook, processed by the job in stripeEventJob.ts, decides that (rule 7). Every figure the app shows is made here as a finished string.
import { createHash, randomUUID } from 'node:crypto';
import { getShard, type Shards } from '../db/clients.js';
import { ApiError } from '../http/errors.js';
import {
  assertValidTarget,
  completeCheckout,
  hasUnprocessedEvent,
  loadOperation,
  lockTeamAndFindPrior,
  nowOf,
  OPERATION_LIFETIME_MS,
  requireNoOpenOperation,
  rethrowOneOpenViolation,
  viewOf,
  type BillingDeps,
  type OperationView,
  type PriorRequest,
  type StoredAnswer,
} from './checkout.js';
import { getScheduledChange, type ScheduledChangeView } from './reductions.js';
import { formatUsd, FIRST_PERIOD_NOTE, PLAN_NAMES, planOptions, TEST_MODE_NOTICE, type PlanOption } from './display.js';
import { monthlyCents, type Entitlements, type PlanId } from './plans.js';
import { periodNumber, utcDateOf } from './periods.js';
import { MIN_CHARGE_CENTS } from './proration.js';
import { memberCountOf, seatLimitOf } from './seats.js';

export { OPERATION_LIFETIME_MS };
export type { BillingDeps, OperationView, StoredAnswer };

export interface BillingOverview {
  testModeNotice: string;
  activated: boolean;
  plans: PlanOption[];
  /** Null until the team activates. */
  subscription: { plan: PlanId; planName: string; seats: number; monthlyDisplay: string; periodStartsOn: string; periodEndsOn: string } | null;
  members: number;
  seatLimit: number;
  /** A payment that is still open (waiting or being confirmed), or null. The hub shows it instead of offering another change. */
  openOperation: OperationView | null;
  /** The reduction the Owner scheduled for the end of the period, or null. */
  scheduledChange: ScheduledChangeView | null;
}

/** The team's open payment, if any (at most one exists: the partial unique index). An open one past its expiry is reported as expired, not as open. */
async function openOperationOf(deps: BillingDeps, teamId: string): Promise<OperationView | null> {
  const open = await getShard(deps.shards, teamId).primary.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM payment_operations WHERE team_id = ${teamId}::uuid AND status = 'open'::payment_operation_status AND expires_at > NOW() LIMIT 1`;
  const id = open[0]?.id;
  if (!id) return null;
  const row = await loadOperation(deps.shards, teamId, id);
  if (!row) return null;
  return viewOf(row, await hasUnprocessedEvent(deps.shards, row.id), nowOf(deps));
}

/** The Owner's billing screen: what the team has, what it could buy, every price already formatted. */
export async function getOverview(deps: BillingDeps, teamId: string): Promise<BillingOverview> {
  const prisma = getShard(deps.shards, teamId).primary;
  const sub = await prisma.$queryRaw<Array<{ plan: PlanId; seats: number; starts_on: string; ends_on: string }>>`
    SELECT s.plan::text AS plan, s.seats, p.starts_on::text AS starts_on, p.ends_on::text AS ends_on
    FROM subscriptions s JOIN billing_periods p ON p.id = s.current_period_id
    WHERE s.team_id = ${teamId}::uuid`;
  const members = await memberCountOf(prisma, teamId);
  const seatLimit = await seatLimitOf(prisma, teamId);
  const row = sub[0];
  return {
    testModeNotice: TEST_MODE_NOTICE,
    activated: row !== undefined,
    plans: planOptions(),
    subscription: row
      ? {
          plan: row.plan,
          planName: PLAN_NAMES[row.plan],
          seats: row.seats,
          monthlyDisplay: formatUsd(monthlyCents({ plan: row.plan, seats: row.seats })),
          periodStartsOn: row.starts_on,
          periodEndsOn: row.ends_on,
        }
      : null,
    members,
    seatLimit,
    openOperation: await openOperationOf(deps, teamId),
    scheduledChange: await getScheduledChange(deps.shards, teamId),
  };
}

export interface ActivationQuote {
  plan: PlanId;
  planName: string;
  seats: number;
  /** What Stripe will be asked to collect today: the full first period, formatted by the server. */
  chargeTodayDisplay: string;
  periodStartsOn: string;
  periodEndsOn: string;
  note: string;
  testModeNotice: string;
}

/** Quotes the first period. Read-only: freezes nothing and calls nobody. */
export async function quoteActivation(deps: BillingDeps, input: { teamId: string; plan: PlanId; seats: number }): Promise<ActivationQuote> {
  const target: Entitlements = { plan: input.plan, seats: input.seats };
  assertValidTarget(target);
  const prisma = getShard(deps.shards, input.teamId).primary;
  const existing = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM subscriptions WHERE team_id = ${input.teamId}::uuid`;
  if (existing.length > 0) throw new ApiError('already_activated');
  if ((await memberCountOf(prisma, input.teamId)) > input.seats) throw new ApiError('seats_below_members');

  const period = periodNumber(utcDateOf(nowOf(deps)), 0);
  return {
    plan: input.plan,
    planName: PLAN_NAMES[input.plan],
    seats: input.seats,
    chargeTodayDisplay: formatUsd(monthlyCents(target)),
    periodStartsOn: period.startsOn,
    periodEndsOn: period.endsOn,
    note: FIRST_PERIOD_NOTE,
    testModeNotice: TEST_MODE_NOTICE,
  };
}

function fingerprintOf(plan: PlanId, seats: number): string {
  return createHash('sha256').update(`activation|${plan}|${seats}`, 'utf8').digest('hex');
}

/**
 * Starts an activation: freezes the quote as a payment operation, makes the one bounded Stripe call, returns the Checkout URL.
 *
 * The app's Idempotency-Key makes a retry harmless: the same key and request returns the stored answer; the same key with a different request is 422.
 * The operation and the key are written in ONE transaction BEFORE Stripe is called, and Stripe's own key is `op-<operationId>`, stable per operation,
 * so a timeout (an uncertain result) is resumed by retrying with the same key: Stripe returns the session it already made.
 */
export async function startActivation(
  deps: BillingDeps,
  input: { teamId: string; actorUserId: string; idempotencyKey: string; plan: PlanId; seats: number },
): Promise<StoredAnswer> {
  const { teamId } = input;
  const target: Entitlements = { plan: input.plan, seats: input.seats };
  assertValidTarget(target);
  const amountCents = monthlyCents(target);
  // The engine's own rule, re-checked where the operation is created (ADR 0026): a charge under Stripe's minimum can never be collected.
  if (amountCents < MIN_CHARGE_CENTS) throw new ApiError('validation_failed', { details: [{ path: 'plan', code: 'invalid' }] });

  const prisma = getShard(deps.shards, teamId).primary;
  const fingerprint = fingerprintOf(input.plan, input.seats);
  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + OPERATION_LIFETIME_MS);
  const newOperationId = randomUUID();

  let step: PriorRequest;
  try {
    step = await prisma.$transaction(
      async (tx): Promise<PriorRequest> => {
        const prior = await lockTeamAndFindPrior(tx, teamId, input.idempotencyKey, fingerprint);
        if (prior.kind !== 'new') return prior;

        const existing = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM subscriptions WHERE team_id = ${teamId}::uuid`;
        if (existing.length > 0) throw new ApiError('already_activated');
        if ((await memberCountOf(tx, teamId)) > input.seats) throw new ApiError('seats_below_members');
        await requireNoOpenOperation(tx, teamId);

        const period = periodNumber(utcDateOf(now), 0);
        // The first period is charged in full (money.md): remaining = period_days, nothing already paid, so nothing credited.
        await tx.$executeRaw`
          INSERT INTO payment_operations (id, team_id, kind, requested_by_user_id, base_version, activation_date, apply_plan, apply_seats,
            period_days, remaining_days, paid_basis_before_cents, gross_charge_cents, credit_cents, quote_cents, paid_basis_after_cents, expires_at)
          VALUES (${newOperationId}::uuid, ${teamId}::uuid, 'activation'::payment_operation_kind, ${input.actorUserId}::uuid, 0, ${utcDateOf(now)}::date,
            ${input.plan}::billing_plan, ${input.seats}, ${period.periodDays}, ${period.periodDays}, 0, ${amountCents}, 0, ${amountCents}, ${amountCents}, ${expiresAt})`;
        await tx.$executeRaw`
          INSERT INTO payment_requests (team_id, user_id, idempotency_key, request_fingerprint, operation_id, response_status, response)
          VALUES (${teamId}::uuid, ${input.actorUserId}::uuid, ${input.idempotencyKey}, ${fingerprint}, ${newOperationId}::uuid, 0, '{}'::jsonb)`;
        return { kind: 'proceed', operationId: newOperationId };
      },
      { maxWait: deps.maxWaitMs },
    );
  } catch (err) {
    rethrowOneOpenViolation(err);
  }

  if (step.kind === 'replay') return { status: step.status === 201 ? 200 : step.status, body: step.body, replay: true };
  if (step.kind !== 'proceed') throw new ApiError('internal_error', { reason: 'unexpected_prior_request' });
  return completeCheckout(deps, { teamId, idempotencyKey: input.idempotencyKey, operationId: step.operationId });
}

/** An operation of this team, as the app should see it. Another team's, or none: 404. */
export async function getOperation(deps: BillingDeps, input: { teamId: string; operationId: string }): Promise<OperationView> {
  const row = await loadOperation(deps.shards, input.teamId, input.operationId);
  if (!row) throw new ApiError('not_found', { reason: 'operation_not_found' });
  const confirming = row.status === 'open' ? await hasUnprocessedEvent(deps.shards, row.id) : false;
  return viewOf(row, confirming, nowOf(deps));
}

/**
 * The buyer backed out of Stripe's page. An open operation ends now, so they can try again straight away; one that is already settled is returned as it is.
 * An operation whose payment has been reported to us (confirming) is not cancelled: that payment is being applied.
 *
 * Limit, written down (ADR 0027): this ends the operation HERE. The Checkout Session on Stripe's side ends at its own expiry (at most 31 minutes), and
 * we do not make a second synchronous Stripe call to close it early (rule 10). A payment made on it in that window is recorded and sent to human review.
 */
export async function cancelOperation(deps: BillingDeps, input: { teamId: string; operationId: string }): Promise<OperationView> {
  const row = await loadOperation(deps.shards, input.teamId, input.operationId);
  if (!row) throw new ApiError('not_found', { reason: 'operation_not_found' });
  if (row.status === 'open') {
    if (await hasUnprocessedEvent(deps.shards, row.id)) throw new ApiError('payment_in_progress', { reason: 'payment_is_being_applied' });
    await getShard(deps.shards, input.teamId).primary.$executeRaw`
      UPDATE payment_operations SET status = 'expired'::payment_operation_status, updated_at = NOW()
      WHERE id = ${row.id}::uuid AND team_id = ${input.teamId}::uuid AND status = 'open'::payment_operation_status`;
  }
  return getOperation(deps, input);
}

