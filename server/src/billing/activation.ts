// Activating a team's subscription (ADR 0027, payments slice P3). The server quotes, freezes a payment operation, and makes the ONE synchronous
// Stripe call (AGENTS.md rule 10): a Checkout Session for an amount our own engine calculated. It never records a payment outcome; only a verified
// webhook, processed by the job in stripeEventJob.ts, decides that (rule 7). Every figure the app shows is made here as a finished string.
import { createHash, randomUUID } from 'node:crypto';
import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { ApiError } from '../http/errors.js';
import { formatUsd, FIRST_PERIOD_NOTE, PLAN_NAMES, planOptions, TEST_MODE_NOTICE, type PlanOption } from './display.js';
import { StripeRejectedError, StripeUncertainError, type StripeGateway } from './gateway.js';
import { entitlementsProblem, monthlyCents, PLANS, type Entitlements, type PlanId } from './plans.js';
import { periodNumber, utcDateOf } from './periods.js';
import { MIN_CHARGE_CENTS } from './proration.js';
import { memberCountOf, seatLimitOf } from './seats.js';

/**
 * How long a payment operation, and the Checkout Session it opened, stay payable: Stripe's 30-minute minimum plus 60 seconds, because Stripe refuses an
 * expiry under 30 minutes from the moment it receives the request and ours is set a moment earlier. The operation and the session end together, so an
 * operation is never open while its session is already dead. CHOSEN, NOT MEASURED (Dave, 2026-10-28: "30 minutes"; the 60 seconds is the margin).
 */
export const OPERATION_LIFETIME_MS = 31 * 60 * 1000;

export interface BillingDeps {
  shards: Shards;
  stripe: StripeGateway;
  /** The https origin of the App Link host (config.invites.linkBaseUrl); Stripe sends the buyer back to `<origin>/checkout/...`. */
  linkBaseUrl: string;
  maxWaitMs: number;
  now?: () => Date;
}

const nowOf = (deps: BillingDeps) => (deps.now ?? (() => new Date()))();

/** What the app is told about an operation: decided here, never by the app. */
export type OperationStatusView = 'awaiting_payment' | 'confirming' | 'paid' | 'failed' | 'expired' | 'under_review';

export interface OperationView {
  id: string;
  kind: 'activation';
  status: OperationStatusView;
  plan: PlanId;
  planName: string;
  seats: number;
  amountDisplay: string;
  expiresAt: string;
}

interface OperationRow {
  id: string;
  team_id: string;
  kind: string;
  status: string;
  apply_plan: PlanId;
  apply_seats: number;
  quote_cents: number;
  expires_at: Date;
  activation_date: string | null;
  stripe_checkout_session_id: string | null;
}

function statusView(row: Pick<OperationRow, 'status' | 'expires_at'>, confirming: boolean, now: Date): OperationStatusView {
  switch (row.status) {
    case 'completed':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'needs_review':
      return 'under_review';
    default:
      if (confirming) return 'confirming';
      return row.expires_at.getTime() <= now.getTime() ? 'expired' : 'awaiting_payment';
  }
}

function viewOf(row: OperationRow, confirming: boolean, now: Date): OperationView {
  return {
    id: row.id,
    kind: 'activation',
    status: statusView(row, confirming, now),
    plan: row.apply_plan,
    planName: PLAN_NAMES[row.apply_plan],
    seats: row.apply_seats,
    amountDisplay: formatUsd(row.quote_cents),
    expiresAt: row.expires_at.toISOString(),
  };
}

async function loadOperation(shards: Shards, teamId: string, operationId: string): Promise<OperationRow | null> {
  // The team id is part of the lookup: another team's operation looks exactly like one that does not exist (404).
  const rows = await getShard(shards, teamId).primary.$queryRaw<OperationRow[]>`
    SELECT id, team_id, kind::text AS kind, status::text AS status, apply_plan::text AS apply_plan, apply_seats, quote_cents, expires_at,
      activation_date::text AS activation_date, stripe_checkout_session_id
    FROM payment_operations WHERE id = ${operationId}::uuid AND team_id = ${teamId}::uuid`;
  return rows[0] ?? null;
}

/** Whether a verified Stripe event for this operation is recorded but not yet processed: the payment is "confirming". Never cached (rule 11). */
async function hasUnprocessedEvent(shards: Shards, operationId: string): Promise<boolean> {
  const row = await identityDb(shards).stripeEvent.findFirst({ where: { operationId, processedAt: null }, select: { eventId: true } });
  return row !== null;
}

function entitlementDetails(problem: string, plan: PlanId, seats: number) {
  if (problem === 'seats_over_plan_limit') return [{ path: 'seats', code: 'too_long', max: PLANS[plan].includedSeats }];
  return [{ path: 'seats', code: 'too_short', min: 1 }];
}

function assertValidTarget(target: Entitlements): void {
  const problem = entitlementsProblem(target);
  if (problem) throw new ApiError('validation_failed', { details: entitlementDetails(problem, target.plan, target.seats) });
}

export interface BillingOverview {
  testModeNotice: string;
  activated: boolean;
  plans: PlanOption[];
  /** Null until the team activates. */
  subscription: { plan: PlanId; planName: string; seats: number; monthlyDisplay: string; periodStartsOn: string; periodEndsOn: string } | null;
  members: number;
  seatLimit: number;
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

export interface StoredAnswer {
  /** The HTTP status to send. */
  status: number;
  body: unknown;
  /** True when this is the stored answer to a repeat of the same Idempotency-Key. */
  replay: boolean;
}

function fingerprintOf(plan: PlanId, seats: number): string {
  return createHash('sha256').update(`activation|${plan}|${seats}`, 'utf8').digest('hex');
}

type Tx1 =
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'proceed'; operationId: string };

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

  let step: Tx1;
  try {
    step = await prisma.$transaction(
      async (tx): Promise<Tx1> => {
        // The team row lock serialises everything that changes who is in the team or what it pays: two requests with one key, an invitation
        // being accepted, a second payment attempt.
        await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;

        const prior = await tx.$queryRaw<Array<{ request_fingerprint: string; operation_id: string | null; response_status: number; response: unknown }>>`
          SELECT request_fingerprint, operation_id, response_status, response FROM payment_requests
          WHERE team_id = ${teamId}::uuid AND idempotency_key = ${input.idempotencyKey}`;
        const found = prior[0];
        if (found) {
          if (found.request_fingerprint !== fingerprint) throw new ApiError('idempotency_mismatch', { reason: 'same_key_different_request' });
          if (found.response_status !== 0) return { kind: 'replay', status: found.response_status, body: found.response };
          // An earlier attempt froze the operation but never learned Stripe's answer: resume it.
          if (!found.operation_id) throw new ApiError('internal_error', { reason: 'payment_request_without_operation' });
          return { kind: 'proceed', operationId: found.operation_id };
        }

        const existing = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM subscriptions WHERE team_id = ${teamId}::uuid`;
        if (existing.length > 0) throw new ApiError('already_activated');
        if ((await memberCountOf(tx, teamId)) > input.seats) throw new ApiError('seats_below_members');

        // An operation nobody paid for before it expired no longer blocks the team.
        await tx.$executeRaw`UPDATE payment_operations SET status = 'expired'::payment_operation_status, updated_at = NOW() WHERE team_id = ${teamId}::uuid AND status = 'open'::payment_operation_status AND expires_at <= NOW()`;
        const open = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM payment_operations WHERE team_id = ${teamId}::uuid AND status = 'open'::payment_operation_status`;
        if (open.length > 0) throw new ApiError('payment_in_progress', { reason: 'an_operation_is_already_open' });

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
    // The partial unique index is the backstop for "one open operation per team" (the lock and the check above make it unreachable in practice).
    if (!(err instanceof ApiError) && String((err as { message?: unknown })?.message).includes('payment_operations_one_open_per_team')) {
      throw new ApiError('payment_in_progress', { reason: 'unique_index' });
    }
    throw err;
  }

  if (step.kind === 'replay') return { status: step.status === 201 ? 200 : step.status, body: step.body, replay: true };

  const operation = await loadOperation(deps.shards, teamId, step.operationId);
  if (!operation) throw new ApiError('internal_error', { reason: 'operation_vanished' });
  // A resumed attempt whose operation has since ended cannot be completed with this key: the app starts again with a new one.
  if (operation.status !== 'open') throw new ApiError('validation_failed', { details: [{ path: 'header.idempotency-key', code: 'key_expired' }] });

  // The one synchronous provider call: bounded by the gateway's timeout, idempotent by operation, and it records NO outcome.
  let session;
  try {
    session = await deps.stripe.createCheckoutSession({
      operationId: operation.id,
      teamId,
      amountCents: operation.quote_cents,
      productName: `Rota ${PLAN_NAMES[operation.apply_plan]} plan, ${operation.apply_seats} seats`,
      successUrl: `${deps.linkBaseUrl}/checkout/return?operation=${operation.id}`,
      cancelUrl: `${deps.linkBaseUrl}/checkout/cancel?operation=${operation.id}`,
      expiresAt: operation.expires_at,
    });
  } catch (err) {
    if (err instanceof StripeRejectedError) {
      // Stripe refused outright: close the operation so the team is not blocked, and remember the answer for this key.
      const failure = { error: { code: 'service_unavailable', message: new ApiError('service_unavailable').message } };
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE payment_operations SET status = 'failed'::payment_operation_status, updated_at = NOW() WHERE id = ${operation.id}::uuid AND team_id = ${teamId}::uuid AND status = 'open'::payment_operation_status`;
          await tx.$executeRaw`UPDATE payment_requests SET response_status = 503, response = ${JSON.stringify(failure)}::jsonb WHERE team_id = ${teamId}::uuid AND idempotency_key = ${input.idempotencyKey} AND response_status = 0`;
        },
        { maxWait: deps.maxWaitMs },
      );
      throw new ApiError('service_unavailable', { reason: `stripe_${err.reason}` });
    }
    if (err instanceof StripeUncertainError) {
      // The outcome is unknown. Nothing is recorded as paid or failed; the same key resumes it.
      throw new ApiError('service_unavailable', { reason: `stripe_uncertain_${err.reason}` });
    }
    throw err;
  }

  const body = { operation: viewOf(operation, false, nowOf(deps)), checkoutUrl: session.url };
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE payment_operations SET stripe_checkout_session_id = ${session.id}, updated_at = NOW()
        WHERE id = ${operation.id}::uuid AND team_id = ${teamId}::uuid AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ${session.id})`;
      await tx.$executeRaw`
        UPDATE payment_requests SET response_status = 201, response = ${JSON.stringify(body)}::jsonb
        WHERE team_id = ${teamId}::uuid AND idempotency_key = ${input.idempotencyKey} AND response_status = 0`;
    },
    { maxWait: deps.maxWaitMs },
  );
  return { status: 201, body, replay: false };
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

