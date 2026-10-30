// The machinery every payment shares: freezing a payment operation, the app's Idempotency-Key, the ONE synchronous Stripe call (AGENTS.md rule 10),
// and what the app is told about an operation. Activation (activation.ts) and plan or seat changes (changes.ts) both build on it.
// It never records a payment outcome; only a verified webhook, processed by the job in stripeEventJob.ts, decides that (rule 7).
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import type { ShardId } from '../db/shard.js';
import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { ApiError } from '../http/errors.js';
import { formatUsd, PLAN_NAMES } from './display.js';
import { StripeRejectedError, StripeUncertainError, type StripeGateway } from './gateway.js';
import { entitlementsProblem, PLANS, type Entitlements, type PlanId } from './plans.js';

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
  /** Enqueues an ALREADY COMMITTED work row (a scheduled reduction's boundary check). Never throws (see `enqueueCommittedRow`). */
  enqueue?: (prisma: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => Promise<void>;
  now?: () => Date;
}

export const nowOf = (deps: BillingDeps) => (deps.now ?? (() => new Date()))();

/** What the app is told about an operation: decided here, never by the app. */
export type OperationStatusView = 'awaiting_payment' | 'confirming' | 'paid' | 'failed' | 'expired' | 'under_review';

export interface OperationView {
  id: string;
  kind: 'activation' | 'change';
  status: OperationStatusView;
  plan: PlanId;
  planName: string;
  seats: number;
  amountDisplay: string;
  expiresAt: string;
}

export interface OperationRow {
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

export function statusView(row: Pick<OperationRow, 'status' | 'expires_at'>, confirming: boolean, now: Date): OperationStatusView {
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

export function viewOf(row: OperationRow, confirming: boolean, now: Date): OperationView {
  return {
    id: row.id,
    kind: row.kind === 'change' ? 'change' : 'activation',
    status: statusView(row, confirming, now),
    plan: row.apply_plan,
    planName: PLAN_NAMES[row.apply_plan],
    seats: row.apply_seats,
    amountDisplay: formatUsd(row.quote_cents),
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function loadOperation(shards: Shards, teamId: string, operationId: string): Promise<OperationRow | null> {
  // The team id is part of the lookup: another team's operation looks exactly like one that does not exist (404).
  const rows = await getShard(shards, teamId).primary.$queryRaw<OperationRow[]>`
    SELECT id, team_id, kind::text AS kind, status::text AS status, apply_plan::text AS apply_plan, apply_seats, quote_cents, expires_at,
      activation_date::text AS activation_date, stripe_checkout_session_id
    FROM payment_operations WHERE id = ${operationId}::uuid AND team_id = ${teamId}::uuid`;
  return rows[0] ?? null;
}

/** Whether a verified Stripe event for this operation is recorded but not yet processed: the payment is "confirming". Never cached (rule 11). */
export async function hasUnprocessedEvent(shards: Shards, operationId: string): Promise<boolean> {
  const row = await identityDb(shards).stripeEvent.findFirst({ where: { operationId, processedAt: null }, select: { eventId: true } });
  return row !== null;
}

function entitlementDetails(problem: string, plan: PlanId) {
  if (problem === 'seats_over_plan_limit') return [{ path: 'seats', code: 'too_long', max: PLANS[plan].includedSeats }];
  return [{ path: 'seats', code: 'too_short', min: 1 }];
}

/** A plan and a seat count that cannot exist (Starter over 5 seats, fewer than 1) is a 400 with the field named. */
export function assertValidTarget(target: Entitlements): void {
  const problem = entitlementsProblem(target);
  if (problem) throw new ApiError('validation_failed', { details: entitlementDetails(problem, target.plan) });
}

export interface StoredAnswer {
  /** The HTTP status to send. */
  status: number;
  body: unknown;
  /** True when this is the stored answer to a repeat of the same Idempotency-Key. */
  replay: boolean;
}

/** The first step of every payment request, inside its transaction: what the team row lock found for this Idempotency-Key. */
export type PriorRequest =
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'proceed'; operationId: string }
  | { kind: 'new' };

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/**
 * Takes the team row lock, which serialises everything that changes who is in the team or what it pays (two requests with one key, an invitation being
 * accepted, a second payment attempt), then looks the key up. The same key with a different request is 422; the same request returns the stored answer;
 * a request whose operation was frozen but whose Stripe answer was never learned is resumed.
 */
export async function lockTeamAndFindPrior(tx: Tx, teamId: string, idempotencyKey: string, fingerprint: string): Promise<PriorRequest> {
  await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
  const prior = await tx.$queryRaw<Array<{ request_fingerprint: string; operation_id: string | null; response_status: number; response: unknown }>>`
    SELECT request_fingerprint, operation_id, response_status, response FROM payment_requests
    WHERE team_id = ${teamId}::uuid AND idempotency_key = ${idempotencyKey}`;
  const found = prior[0];
  if (!found) return { kind: 'new' };
  if (found.request_fingerprint !== fingerprint) throw new ApiError('idempotency_mismatch', { reason: 'same_key_different_request' });
  if (found.response_status !== 0) return { kind: 'replay', status: found.response_status, body: found.response };
  if (!found.operation_id) throw new ApiError('internal_error', { reason: 'payment_request_without_operation' });
  return { kind: 'proceed', operationId: found.operation_id };
}

/** One open payment per team (money.md): an operation nobody paid for before it expired no longer blocks; any other open one is 409. */
export async function requireNoOpenOperation(tx: Tx, teamId: string): Promise<void> {
  await tx.$executeRaw`UPDATE payment_operations SET status = 'expired'::payment_operation_status, updated_at = NOW() WHERE team_id = ${teamId}::uuid AND status = 'open'::payment_operation_status AND expires_at <= NOW()`;
  const open = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM payment_operations WHERE team_id = ${teamId}::uuid AND status = 'open'::payment_operation_status`;
  if (open.length > 0) throw new ApiError('payment_in_progress', { reason: 'an_operation_is_already_open' });
}

/** The partial unique index is the backstop for "one open operation per team" (the lock and the check above make it unreachable in practice). */
export function rethrowOneOpenViolation(err: unknown): never {
  if (!(err instanceof ApiError) && String((err as { message?: unknown })?.message).includes('payment_operations_one_open_per_team')) {
    throw new ApiError('payment_in_progress', { reason: 'unique_index' });
  }
  throw err;
}

/**
 * From a frozen, open operation to Stripe's Checkout URL: the ONE synchronous provider call, bounded by the gateway's timeout, idempotent by operation, and
 * it records NO outcome. A definite refusal closes the operation (so the team is not blocked) and remembers that answer for the key; an uncertain result
 * leaves everything as it is, so the same key resumes it (Stripe returns the session it already made).
 */
export async function completeCheckout(deps: BillingDeps, input: { teamId: string; idempotencyKey: string; operationId: string }): Promise<StoredAnswer> {
  const { teamId } = input;
  const prisma = getShard(deps.shards, teamId).primary;
  const operation = await loadOperation(deps.shards, teamId, input.operationId);
  if (!operation) throw new ApiError('internal_error', { reason: 'operation_vanished' });
  // A resumed attempt whose operation has since ended cannot be completed with this key: the app starts again with a new one.
  if (operation.status !== 'open') throw new ApiError('validation_failed', { details: [{ path: 'header.idempotency-key', code: 'key_expired' }] });

  let session;
  try {
    session = await deps.stripe.createCheckoutSession({
      operationId: operation.id,
      teamId,
      amountCents: operation.quote_cents,
      productName: operation.kind === 'change' ? `Rota plan change: ${PLAN_NAMES[operation.apply_plan]}, ${operation.apply_seats} seats` : `Rota ${PLAN_NAMES[operation.apply_plan]} plan, ${operation.apply_seats} seats`,
      successUrl: `${deps.linkBaseUrl}/checkout/return?operation=${operation.id}`,
      cancelUrl: `${deps.linkBaseUrl}/checkout/cancel?operation=${operation.id}`,
      expiresAt: operation.expires_at,
    });
  } catch (err) {
    if (err instanceof StripeRejectedError) {
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
    if (err instanceof StripeUncertainError) throw new ApiError('service_unavailable', { reason: `stripe_uncertain_${err.reason}` });
    throw err;
  }

  const body = { status: 'payment_required', operation: viewOf(operation, false, nowOf(deps)), checkoutUrl: session.url };
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
