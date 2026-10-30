// The Stripe event processing job (AGENTS.md rules 6 to 9; money.md "Webhooks and confirming a payment"; the webhook-handler skill).
// A valid signature proves Stripe sent the event, NOT that this change was paid for. So the job applies a payment only when every field matches
// the operation we froze, and it does so in ONE transaction on the team's shard. Only AFTER that commits is the inbox row marked processed, so a
// crash in between is safe: the replay finds the operation complete and only finishes the inbox.
//
// Outcomes, stored on the inbox row: applied | duplicate (already applied) | review (recorded, not applied, a human looks) | ignored (nothing to do).
import { getShard, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { TerminalJobError, type JobHandler } from '../jobs/worker.js';
import { insertLedgerRows } from './ledgerDb.js';
import { ledgerRowsForActivation, ledgerRowsForChange } from './ledger.js';
import { CURRENCY, monthlyCents, type PlanId } from './plans.js';
import { quoteChange } from './proration.js';
import { anchorDayOf, periodNumber } from './periods.js';
import { stripeEventJobPayload, type StripeEventJobPayload } from './stripeEvent.js';
import { memberCountOf } from './seats.js';

export type EventOutcome = 'applied' | 'duplicate' | 'review' | 'ignored';
interface Result {
  outcome: EventOutcome;
  /** For the log only. Never shown to the app. */
  detail: string;
}

interface OperationRow {
  id: string;
  kind: string;
  status: string;
  base_version: number;
  activation_date: string | null;
  period_id: string | null;
  from_plan: PlanId | null;
  from_seats: number | null;
  apply_plan: PlanId;
  apply_seats: number;
  scheduled_plan: PlanId | null;
  scheduled_seats: number | null;
  period_days: number;
  remaining_days: number;
  paid_basis_before_cents: number;
  gross_charge_cents: number;
  credit_cents: number;
  quote_cents: number;
  paid_basis_after_cents: number;
  currency: string;
  stripe_checkout_session_id: string | null;
}

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;
type Flag = (reason: string) => Promise<Result>;

async function completeOperation(tx: Tx, p: StripeEventJobPayload, operationId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE payment_operations
    SET status = 'completed'::payment_operation_status, stripe_payment_intent_id = ${p.paymentIntentId}, stripe_checkout_session_id = ${p.sessionId},
        completed_at = NOW(), updated_at = NOW()
    WHERE id = ${operationId}::uuid AND team_id = ${p.teamId}::uuid`;
}

/** The first payment: starts the team's subscription and its first period. Run inside the apply transaction, after every field matched. */
async function applyActivation(tx: Tx, p: StripeEventJobPayload, op: OperationRow, flag: Flag): Promise<Result> {
  if (op.activation_date === null) return flag('unsupported_operation_kind');
  // The amount is re-derived by our own engine, not trusted from the row alone.
  const entitlements = { plan: op.apply_plan, seats: op.apply_seats };
  const monthly = monthlyCents(entitlements);
  if (monthly !== op.quote_cents) return flag('quote_does_not_match_engine');

  // Serialise with invitations being accepted (they take the same lock), then check the team still fits the seats it bought.
  await tx.$queryRaw`SELECT id FROM teams WHERE id = ${p.teamId}::uuid FOR UPDATE`;
  const existing = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM subscriptions WHERE team_id = ${p.teamId}::uuid`;
  if (existing.length > 0 || op.base_version !== 0) return flag('subscription_already_exists');
  if ((await memberCountOf(tx, p.teamId)) > op.apply_seats) return flag('members_exceed_seats');

  const period = periodNumber(op.activation_date, 0);
  const periodRows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO billing_periods (team_id, starts_on, ends_on, period_days)
    VALUES (${p.teamId}::uuid, ${period.startsOn}::date, ${period.endsOn}::date, ${period.periodDays})
    ON CONFLICT (team_id, starts_on) DO UPDATE SET team_id = EXCLUDED.team_id
    RETURNING id`;
  const periodId = periodRows[0]!.id;

  await insertLedgerRows(tx, p.teamId, ledgerRowsForActivation({ operationId: op.id, periodId, entitlements }), p.paymentIntentId!);
  await tx.$executeRaw`
    INSERT INTO subscriptions (team_id, plan, seats, billing_anchor_day, paid_basis_cents, version, current_period_id, activated_at)
    VALUES (${p.teamId}::uuid, ${op.apply_plan}::billing_plan, ${op.apply_seats}, ${anchorDayOf(op.activation_date)}, ${monthly}, 1, ${periodId}::uuid, NOW())`;
  await completeOperation(tx, p, op.id);
  return { outcome: 'applied', detail: 'activation_applied' };
}

/**
 * A paid plan or seat change (money.md): applies only against the subscription version it was quoted against. A mismatch NEVER applies: the payment is
 * recorded and the operation goes to human review. The charge is re-derived by our own engine from the frozen inputs and must equal the quote. One
 * transaction writes the credit, the charge and the entitlement change, raises the subscription's paid basis and version, and completes the operation.
 */
async function applyChange(tx: Tx, p: StripeEventJobPayload, op: OperationRow, flag: Flag): Promise<Result> {
  if (!op.period_id || !op.from_plan || op.from_seats === null) return flag('unsupported_operation_kind');
  await tx.$queryRaw`SELECT id FROM teams WHERE id = ${p.teamId}::uuid FOR UPDATE`;
  const subs = await tx.$queryRaw<Array<{ plan: PlanId; seats: number; paid_basis_cents: number; version: number; current_period_id: string }>>`
    SELECT plan::text AS plan, seats, paid_basis_cents, version, current_period_id::text AS current_period_id
    FROM subscriptions WHERE team_id = ${p.teamId}::uuid FOR UPDATE`;
  const sub = subs[0];
  if (!sub) return flag('subscription_missing');
  if (sub.version !== op.base_version) return flag('version_mismatch');
  if (sub.current_period_id !== op.period_id) return flag('period_changed');
  if (sub.plan !== op.from_plan || sub.seats !== op.from_seats) return flag('base_state_mismatch');

  const target = op.scheduled_plan && op.scheduled_seats !== null ? { plan: op.scheduled_plan, seats: op.scheduled_seats } : { plan: op.apply_plan, seats: op.apply_seats };
  const quote = quoteChange({
    current: { plan: sub.plan, seats: sub.seats },
    target,
    paidBasisCents: sub.paid_basis_cents,
    periodDays: op.period_days,
    remainingDays: op.remaining_days,
  });
  const calc = quote.calculation;
  if (
    quote.kind !== 'paid' || !calc || quote.chargeCents !== op.quote_cents || quote.paidBasisAfterCents !== op.paid_basis_after_cents ||
    calc.grossChargeCents !== op.gross_charge_cents || calc.creditCents !== op.credit_cents ||
    quote.applyNow.plan !== op.apply_plan || quote.applyNow.seats !== op.apply_seats
  ) {
    return flag('quote_does_not_match_engine');
  }

  await insertLedgerRows(tx, p.teamId, ledgerRowsForChange({ operationId: op.id, periodId: op.period_id, quote }), p.paymentIntentId!);
  await tx.$executeRaw`
    UPDATE subscriptions
    SET plan = ${quote.applyNow.plan}::billing_plan, seats = ${quote.applyNow.seats}, paid_basis_cents = ${quote.paidBasisAfterCents}, version = version + 1, updated_at = NOW()
    WHERE team_id = ${p.teamId}::uuid`;
  await completeOperation(tx, p, op.id);
  return { outcome: 'applied', detail: 'change_applied' };
}

/** An operation that ended without a payment (expired, failed) when Stripe says the session ended that way. Only an OPEN operation can end. */
async function closeOperation(team: PrismaClient, p: StripeEventJobPayload, status: 'expired' | 'failed'): Promise<Result> {
  const closed = await team.$executeRaw`
    UPDATE payment_operations SET status = ${status}::payment_operation_status, updated_at = NOW()
    WHERE id = ${p.operationId}::uuid AND team_id = ${p.teamId}::uuid AND status = 'open'::payment_operation_status
      AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ${p.sessionId})`;
  return closed > 0 ? { outcome: 'applied', detail: `operation_${status}` } : { outcome: 'ignored', detail: 'operation_not_open' };
}

/**
 * Applies a verified, successful payment to the operation it names, or records why it did not. One transaction on the team's shard: the ledger rows,
 * the subscription, the payment id and the operation's completion commit together or not at all.
 */
async function applyPayment(team: PrismaClient, p: StripeEventJobPayload): Promise<Result> {
  return team.$transaction(
    async (tx): Promise<Result> => {
      const found = await tx.$queryRaw<OperationRow[]>`
        SELECT id, kind::text AS kind, status::text AS status, base_version, activation_date::text AS activation_date, period_id::text AS period_id,
          from_plan::text AS from_plan, from_seats, apply_plan::text AS apply_plan, apply_seats, scheduled_plan::text AS scheduled_plan, scheduled_seats,
          period_days, remaining_days, paid_basis_before_cents, gross_charge_cents, credit_cents, quote_cents, paid_basis_after_cents, currency,
          stripe_checkout_session_id
        FROM payment_operations WHERE id = ${p.operationId}::uuid AND team_id = ${p.teamId}::uuid FOR UPDATE`;
      const op = found[0];
      if (!op) return { outcome: 'review', detail: 'operation_not_found' };

      // A Checkout Session can be "complete" and still unpaid (a delayed method). Wait for the async success event; apply nothing now.
      if (p.paymentStatus !== 'paid') return { outcome: 'ignored', detail: `payment_status_${p.paymentStatus ?? 'missing'}` };

      /** Records that a payment was taken but could not be applied: a human looks. Never raises, never applies. */
      const flag: Flag = async (reason) => {
        await tx.$executeRaw`
          UPDATE payment_operations SET status = 'needs_review'::payment_operation_status, review_reason = ${`${reason} (payment ${p.paymentIntentId ?? 'unknown'})`}, updated_at = NOW()
          WHERE id = ${op.id}::uuid AND team_id = ${p.teamId}::uuid AND status IN ('open'::payment_operation_status, 'expired'::payment_operation_status, 'failed'::payment_operation_status)`;
        return { outcome: 'review', detail: reason };
      };

      if (!p.paymentIntentId) return flag('payment_intent_missing');

      // Already applied? An operation that records this payment id means this is a second event for the same payment: do nothing.
      const sameIntent = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM payment_operations WHERE stripe_payment_intent_id = ${p.paymentIntentId}`;
      if (sameIntent.length > 0) {
        return sameIntent[0]!.id === op.id
          ? { outcome: 'duplicate', detail: 'payment_already_applied' }
          : { outcome: 'review', detail: 'payment_recorded_under_another_operation' };
      }
      // Completed, but by a different payment: this one is extra money. Recorded, not applied, a human looks.
      if (op.status === 'completed') return { outcome: 'review', detail: 'operation_completed_under_a_different_payment' };
      if (op.status !== 'open') return flag(`paid_after_${op.status}`);

      // Every field must match what we froze (money.md). Team is already part of the lookup above.
      if (p.amountTotal !== op.quote_cents) return flag('amount_mismatch');
      if (p.currency !== CURRENCY || op.currency !== CURRENCY) return flag('currency_mismatch');
      if (op.stripe_checkout_session_id !== null && op.stripe_checkout_session_id !== p.sessionId) return flag('session_mismatch');
      if (op.kind === 'activation') return applyActivation(tx, p, op, flag);
      if (op.kind === 'change') return applyChange(tx, p, op, flag);
      return flag('unsupported_operation_kind');
    },
    // The job runs in the background; a cold Neon connection can take seconds to start (auth config: transactionMaxWaitMs).
    { maxWait: 5000, timeout: 15_000 },
  );
}

export function createStripeEventHandler(deps: { shards: Shards }): JobHandler {
  return async (ctx) => {
    const { row, prisma } = ctx;
    const logBase = `[stripe_event] row_id=${row.id} generation=${row.generation} origin_request_id=${row.originRequestId ?? '-'}`;

    const parsed = stripeEventJobPayload.safeParse(row.payload);
    if (!parsed.success) throw new TerminalJobError('invalid_payload');
    const p = parsed.data;

    const event = await prisma.stripeEvent.findUnique({ where: { eventId: p.eventId } });
    if (!event) throw new TerminalJobError('event_missing');
    if (event.processedAt) {
      console.log(`${logBase} event_id=${p.eventId} outcome=already_processed`);
      return;
    }
    if (event.livemode) throw new TerminalJobError('live_mode_event');

    const team = getShard(deps.shards, p.teamId).primary;
    let result: Result;
    if (p.type === 'checkout.session.expired') result = await closeOperation(team, p, 'expired');
    else if (p.type === 'checkout.session.async_payment_failed') result = await closeOperation(team, p, 'failed');
    else result = await applyPayment(team, p);

    // Only now, after the team-shard transaction committed, is the inbox row marked processed (money.md). A crash before this line re-runs the job,
    // which finds the operation complete and ends up here again.
    await prisma.$executeRaw`UPDATE stripe_events SET processed_at = NOW(), outcome = ${result.outcome} WHERE event_id = ${p.eventId} AND processed_at IS NULL`;

    const line = `${logBase} event_id=${p.eventId} operation_id=${p.operationId} team_id=${p.teamId} type=${p.type} outcome=${result.outcome} detail=${result.detail}`;
    if (result.outcome === 'review') console.error(`${line} NEEDS_HUMAN_REVIEW`);
    else console.log(line);
  };
}
