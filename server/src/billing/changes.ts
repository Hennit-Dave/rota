// Changing an active subscription's plan or seats (ADR 0028, payments slice P4), and the billing history.
// The engine (proration.ts) does ALL the arithmetic; this file loads the state from the database, asks the engine, and turns its answer into the words and
// the rows. A paid change is frozen as a payment operation and collected through Checkout exactly like activation (checkout.ts); only a verified webhook
// applies it (stripeEventJob.ts, `applyChange`). A change that needs no payment applies at once, in one transaction, with its own ledger row.
// Every figure the app shows is made here as a finished string (AGENTS.md rule 2).
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getShard } from '../db/clients.js';
import { ApiError } from '../http/errors.js';
import {
  assertValidTarget,
  completeCheckout,
  lockTeamAndFindPrior,
  nowOf,
  OPERATION_LIFETIME_MS,
  requireNoOpenOperation,
  rethrowOneOpenViolation,
  type BillingDeps,
  type PriorRequest,
  type StoredAnswer,
} from './checkout.js';
import { formatSignedUsd, formatUsd, PLAN_NAMES, TEST_MODE_NOTICE } from './display.js';
import { ledgerRowsForChange } from './ledger.js';
import { insertLedgerRows } from './ledgerDb.js';
import { monthlyCents, type Entitlements, type PlanId } from './plans.js';
import { remainingDays, utcDateOf, type Period } from './periods.js';
import { MIN_CHARGE_CENTS, quoteChange, type ChangeQuote } from './proration.js';

/**
 * A paid change is refused in the last stretch of a period ("try after renewal"): a payment operation stays open for OPERATION_LIFETIME_MS, and one
 * cannot be applied across a period boundary (money.md; decision 5 of the payments plan, approved by Dave 2026-10-28 as "the last 30 minutes").
 * It is the operation's own lifetime (31 minutes: ADR 0027, choice 1) so an operation can never outlive the period it was priced in.
 */
export const PAID_CHANGE_CUTOFF_MS = OPERATION_LIFETIME_MS;

/** The subscription as the database holds it, with the period it is in. Read from the primary, never cached (AGENTS.md rule 11). */
interface SubscriptionState {
  plan: PlanId;
  seats: number;
  paid_basis_cents: number;
  version: number;
  current_period_id: string;
  starts_on: string;
  ends_on: string;
  period_days: number;
}

type Db = Pick<PrismaClient, '$queryRaw'>;

async function loadSubscriptionState(db: Db, teamId: string, lock: boolean): Promise<SubscriptionState | null> {
  const rows = lock
    ? await db.$queryRaw<SubscriptionState[]>`
        SELECT s.plan::text AS plan, s.seats, s.paid_basis_cents, s.version, s.current_period_id::text AS current_period_id,
          p.starts_on::text AS starts_on, p.ends_on::text AS ends_on, p.period_days
        FROM subscriptions s JOIN billing_periods p ON p.id = s.current_period_id
        WHERE s.team_id = ${teamId}::uuid FOR UPDATE OF s`
    : await db.$queryRaw<SubscriptionState[]>`
        SELECT s.plan::text AS plan, s.seats, s.paid_basis_cents, s.version, s.current_period_id::text AS current_period_id,
          p.starts_on::text AS starts_on, p.ends_on::text AS ends_on, p.period_days
        FROM subscriptions s JOIN billing_periods p ON p.id = s.current_period_id
        WHERE s.team_id = ${teamId}::uuid`;
  return rows[0] ?? null;
}

export interface EntitlementView {
  plan: PlanId;
  planName: string;
  seats: number;
}

const entitlementView = (e: Entitlements): EntitlementView => ({ plan: e.plan, planName: PLAN_NAMES[e.plan], seats: e.seats });

export type ChangeEffect = 'none' | 'now' | 'after_payment' | 'at_period_end' | 'mixed';

export interface ChangeQuoteView {
  /** When it takes effect: now (no payment), after_payment, at_period_end (a decrease only), or mixed (an increase now and a decrease later). */
  effect: ChangeEffect;
  /** False while the change cannot be made through `POST /changes` (anything with a decrease, until reductions exist). The app shows the headline and offers no button. */
  supported: boolean;
  current: EntitlementView;
  applyNow: EntitlementView;
  atPeriodEnd: EntitlementView | null;
  /** What Stripe will be asked to collect today, or null when nothing is. */
  chargeTodayDisplay: string | null;
  /** The monthly amount of the entitlements after any scheduled change: what the next renewal charges. */
  nextRenewalDisplay: string;
  remainingDays: number;
  periodEndsOn: string;
  /** The server's own sentence for this quote. */
  headline: string;
  testModeNotice: string;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * The words for a quote. Pure: every number in the sentence comes from the engine's answer, formatted here.
 * An "immediate" change that nonetheless raises the monthly amount is the under-the-minimum case (money.md): the charge was smaller than Stripe can collect.
 */
export function describeChange(input: { quote: ChangeQuote; paidBasisCents: number; remaining: number }): { effect: ChangeEffect; supported: boolean; headline: string } {
  const { quote, paidBasisCents, remaining } = input;
  const later = quote.atPeriodEnd !== null;
  switch (quote.kind) {
    case 'none':
      return { effect: 'none', supported: false, headline: 'This is the plan and the number of seats you already have.' };
    case 'scheduled_only':
      return { effect: 'at_period_end', supported: false, headline: 'Reductions are not available yet. For now you can add seats or move to a higher plan.' };
    case 'paid':
      return {
        effect: later ? 'mixed' : 'after_payment',
        supported: !later,
        headline: later
          ? 'Reductions are not available yet. For now you can add seats or move to a higher plan.'
          : `You’ll be charged ${formatUsd(quote.chargeCents)} today for the ${days(remaining)} left in this period. Your change starts once the payment is confirmed.`,
      };
    case 'immediate': {
      if (later) return { effect: 'mixed', supported: false, headline: 'Reductions are not available yet. For now you can add seats or move to a higher plan.' };
      const underMinimum = monthlyCents(quote.applyNow) > paidBasisCents;
      return {
        effect: 'now',
        supported: true,
        headline: underMinimum
          ? `This change costs less than Stripe’s ${formatUsd(MIN_CHARGE_CENTS)} minimum, so it starts now at no charge. The new monthly amount applies from your next renewal.`
          : 'No charge today. Your change starts now and the new monthly amount applies from your next renewal.',
      };
    }
  }
}

interface Assessment {
  quote: ChangeQuote;
  period: Period;
  remaining: number;
}

/**
 * Asks the engine about a change against the state in the database. Refuses outright (409) a change at or after the end of the period (no renewal exists
 * yet to start the next one) and, for a paid change, one in the last PAID_CHANGE_CUTOFF_MS of the period.
 */
function assess(state: SubscriptionState, target: Entitlements, now: Date): Assessment {
  const today = utcDateOf(now);
  const period: Period = { startsOn: state.starts_on, endsOn: state.ends_on, periodDays: state.period_days };
  if (today >= period.endsOn || today < period.startsOn) throw new ApiError('period_ended', { reason: `today_${today}_period_${period.startsOn}_${period.endsOn}` });
  const remaining = remainingDays(period, today);
  const quote = quoteChange({
    current: { plan: state.plan, seats: state.seats },
    target,
    paidBasisCents: state.paid_basis_cents,
    periodDays: period.periodDays,
    remainingDays: remaining,
  });
  const msToEnd = Date.parse(`${period.endsOn}T00:00:00.000Z`) - now.getTime();
  if (quote.kind === 'paid' && msToEnd < PAID_CHANGE_CUTOFF_MS) throw new ApiError('period_ending', { reason: `ms_to_period_end_${msToEnd}` });
  return { quote, period, remaining };
}

/** Quotes a change. Read-only: freezes nothing and calls nobody. */
export async function getChangeQuote(deps: BillingDeps, input: { teamId: string; plan: PlanId; seats: number }): Promise<ChangeQuoteView> {
  const target: Entitlements = { plan: input.plan, seats: input.seats };
  assertValidTarget(target);
  const state = await loadSubscriptionState(getShard(deps.shards, input.teamId).primary, input.teamId, false);
  if (!state) throw new ApiError('not_activated');
  const { quote, period, remaining } = assess(state, target, nowOf(deps));
  const words = describeChange({ quote, paidBasisCents: state.paid_basis_cents, remaining });
  return {
    effect: words.effect,
    supported: words.supported,
    current: entitlementView({ plan: state.plan, seats: state.seats }),
    applyNow: entitlementView(quote.applyNow),
    atPeriodEnd: quote.atPeriodEnd ? entitlementView(quote.atPeriodEnd) : null,
    chargeTodayDisplay: quote.chargeCents > 0 ? formatUsd(quote.chargeCents) : null,
    nextRenewalDisplay: formatUsd(quote.nextRenewalCents),
    remainingDays: remaining,
    periodEndsOn: period.endsOn,
    headline: words.headline,
    testModeNotice: TEST_MODE_NOTICE,
  };
}

function fingerprintOf(plan: PlanId, seats: number): string {
  return createHash('sha256').update(`change|${plan}|${seats}`, 'utf8').digest('hex');
}

type ChangeStep = PriorRequest | { kind: 'applied'; status: number; body: unknown };

/**
 * Makes a change. Under the team row lock, against the state the database holds NOW: a change that needs no payment applies in this one transaction
 * (a fresh operation id, one `entitlement_change` ledger row, the subscription updated and its version raised); a paid change is frozen as a payment
 * operation (quote, base version, period) and goes to Checkout. The app's Idempotency-Key makes a retry harmless, as for activation.
 * Anything with a decrease is refused (409) until reductions exist.
 */
export async function startChange(
  deps: BillingDeps,
  input: { teamId: string; actorUserId: string; idempotencyKey: string; plan: PlanId; seats: number },
): Promise<StoredAnswer> {
  const { teamId } = input;
  const target: Entitlements = { plan: input.plan, seats: input.seats };
  assertValidTarget(target);
  const prisma = getShard(deps.shards, teamId).primary;
  const fingerprint = fingerprintOf(input.plan, input.seats);
  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + OPERATION_LIFETIME_MS);
  const newOperationId = randomUUID();

  let step: ChangeStep;
  try {
    step = await prisma.$transaction(
      async (tx): Promise<ChangeStep> => {
        const prior = await lockTeamAndFindPrior(tx, teamId, input.idempotencyKey, fingerprint);
        if (prior.kind !== 'new') return prior;

        const state = await loadSubscriptionState(tx, teamId, true);
        if (!state) throw new ApiError('not_activated');
        // While a payment is open every other subscription change is 409 (money.md): an immediate one too, because it would change what the payment was quoted against.
        await requireNoOpenOperation(tx, teamId);
        const { quote, period, remaining } = assess(state, target, now);
        if (quote.kind === 'none') throw new ApiError('validation_failed', { details: [{ path: 'plan', code: 'nothing_to_change' }] });
        if (quote.atPeriodEnd !== null) throw new ApiError('scheduled_change_unavailable');

        if (quote.kind === 'immediate') {
          await insertLedgerRows(tx, teamId, ledgerRowsForChange({ operationId: newOperationId, periodId: state.current_period_id, quote }), null);
          await tx.$executeRaw`
            UPDATE subscriptions
            SET plan = ${quote.applyNow.plan}::billing_plan, seats = ${quote.applyNow.seats}, paid_basis_cents = ${quote.paidBasisAfterCents}, version = version + 1, updated_at = NOW()
            WHERE team_id = ${teamId}::uuid`;
          const words = describeChange({ quote, paidBasisCents: state.paid_basis_cents, remaining });
          const body = {
            status: 'applied',
            change: { ...entitlementView(quote.applyNow), message: words.headline, nextRenewalDisplay: formatUsd(quote.nextRenewalCents), periodEndsOn: period.endsOn },
          };
          await tx.$executeRaw`
            INSERT INTO payment_requests (team_id, user_id, idempotency_key, request_fingerprint, operation_id, response_status, response)
            VALUES (${teamId}::uuid, ${input.actorUserId}::uuid, ${input.idempotencyKey}, ${fingerprint}, ${newOperationId}::uuid, 201, ${JSON.stringify(body)}::jsonb)`;
          return { kind: 'applied', status: 201, body };
        }

        // A paid change: frozen. The calculation is stored whole (money.md) and re-derived by the job before it is applied.
        const calc = quote.calculation;
        if (quote.kind !== 'paid' || !calc) throw new ApiError('internal_error', { reason: 'paid_change_without_calculation' });
        await tx.$executeRaw`
          INSERT INTO payment_operations (id, team_id, kind, requested_by_user_id, base_version, period_id, from_plan, from_seats, apply_plan, apply_seats,
            period_days, remaining_days, paid_basis_before_cents, gross_charge_cents, credit_cents, quote_cents, paid_basis_after_cents, expires_at)
          VALUES (${newOperationId}::uuid, ${teamId}::uuid, 'change'::payment_operation_kind, ${input.actorUserId}::uuid, ${state.version}, ${state.current_period_id}::uuid,
            ${state.plan}::billing_plan, ${state.seats}, ${quote.applyNow.plan}::billing_plan, ${quote.applyNow.seats},
            ${calc.periodDays}, ${calc.remainingDays}, ${calc.paidBasisCents}, ${calc.grossChargeCents}, ${calc.creditCents}, ${quote.chargeCents}, ${quote.paidBasisAfterCents}, ${expiresAt})`;
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
  if (step.kind === 'applied') return { status: step.status, body: step.body, replay: false };
  if (step.kind !== 'proceed') throw new ApiError('internal_error', { reason: 'unexpected_prior_request' });
  return completeCheckout(deps, { teamId, idempotencyKey: input.idempotencyKey, operationId: step.operationId });
}

// ---- Billing history ----

/** How many operations one history answer holds. CHOSEN, NOT MEASURED (ADR 0028); `hasMore` says when there are older ones. */
export const HISTORY_PAGE_SIZE = 50;

export interface HistoryLine {
  label: string;
  amountDisplay: string;
}

export interface HistoryEntry {
  /** The business operation: a payment operation's id, or a fresh id for a change that needed no payment. */
  id: string;
  /** UTC calendar date of the first row. */
  date: string;
  title: string;
  /** What the team had after it, e.g. "Team · 18 seats". Absent for a row that carries no state. */
  detail: string | null;
  /** What was paid in net: "+$3.60", or "No charge". */
  netDisplay: string;
  lines: HistoryLine[];
}

const MONEY_LABELS: Record<string, string> = { charge: 'Charge', credit: 'Credit', refund: 'Refund', correction: 'Correction' };

interface HistoryRow {
  operation_id: string;
  entry_type: string;
  amount_cents: number;
  plan: PlanId | null;
  seats: number | null;
  created_on: string;
}

/** The team's money history, newest first, straight from the ledger (rule 8): charges, credits, refunds, corrections and every plan or seat change. */
export async function getHistory(deps: BillingDeps, teamId: string): Promise<{ history: HistoryEntry[]; hasMore: boolean }> {
  const prisma = getShard(deps.shards, teamId).primary;
  const newest = await prisma.$queryRaw<Array<{ operation_id: string }>>`
    SELECT operation_id::text AS operation_id FROM ledger_entries WHERE team_id = ${teamId}::uuid
    GROUP BY operation_id ORDER BY max(position) DESC LIMIT ${HISTORY_PAGE_SIZE + 1}`;
  const hasMore = newest.length > HISTORY_PAGE_SIZE;
  const ids = newest.slice(0, HISTORY_PAGE_SIZE).map((r) => r.operation_id);
  if (ids.length === 0) return { history: [], hasMore: false };
  const rows = await prisma.$queryRaw<HistoryRow[]>`
    SELECT operation_id::text AS operation_id, entry_type::text AS entry_type, amount_cents, plan::text AS plan, seats, (created_at AT TIME ZONE 'UTC')::date::text AS created_on
    FROM ledger_entries WHERE team_id = ${teamId}::uuid AND operation_id = ANY(${ids}::uuid[]) ORDER BY position ASC`;

  const byOperation = new Map<string, HistoryRow[]>();
  for (const row of rows) byOperation.set(row.operation_id, [...(byOperation.get(row.operation_id) ?? []), row]);
  const history = ids.map((id): HistoryEntry => {
    const group = byOperation.get(id) ?? [];
    const money = group.filter((r) => r.entry_type in MONEY_LABELS);
    const state = group.find((r) => r.entry_type === 'entitlement_change') ?? group.find((r) => r.entry_type === 'period_start');
    const net = money.reduce((sum, r) => sum + r.amount_cents, 0);
    const started = group.some((r) => r.entry_type === 'period_start');
    return {
      id,
      date: group[0]?.created_on ?? '',
      title: started ? 'Subscription activated' : state ? 'Plan or seats changed' : 'Adjustment',
      detail: state?.plan && state.seats !== null ? `${PLAN_NAMES[state.plan]} · ${state.seats} seats` : null,
      netDisplay: net === 0 ? 'No charge' : formatSignedUsd(net),
      lines: money.map((r) => ({ label: MONEY_LABELS[r.entry_type]!, amountDisplay: formatSignedUsd(r.amount_cents) })),
    };
  });
  return { history, hasMore };
}
