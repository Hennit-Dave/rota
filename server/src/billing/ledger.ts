// The ledger as pure functions (money.md, AGENTS.md rule 8). Rows are append-only in the database (a trigger rejects UPDATE and DELETE);
// subscription state is a projection that must always be rebuildable from them. `ledgerRowsFor*` says which rows a change writes;
// `rebuildSubscription` folds rows back into state; the tests prove the two agree.
import { assertEntitlements, BillingInputError, monthlyCents, type Entitlements, type PlanId } from './plans.js';
import type { ChangeQuote } from './proration.js';

export const LEDGER_ENTRY_TYPES = ['period_start', 'entitlement_change', 'charge', 'credit', 'refund', 'correction'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** Entries that carry subscription state (plan, seats, paid basis). The others carry only money. */
export const STATE_ENTRY_TYPES: readonly LedgerEntryType[] = ['period_start', 'entitlement_change'];

export interface LedgerRow {
  /** The business operation this row belongs to: a payment operation's ID for a paid change, a fresh ID for any other change. */
  operationId: string;
  entryType: LedgerEntryType;
  /** Ordinal among rows of the same type inside one operation, from 1. Together with the two above it is the deduplication key. */
  sequence: number;
  /** Signed cents. Charges are positive; credits and refunds negative; state rows carry 0. */
  amountCents: number;
  periodId: string | null;
  plan: PlanId | null;
  seats: number | null;
  paidBasisAfterCents: number | null;
}

export interface SubscriptionState {
  plan: PlanId;
  seats: number;
  paidBasisCents: number;
  currentPeriodId: string;
  /** Counts the operations that changed the subscription. Starts at 1 on activation. A payment operation applies only against its base version. */
  version: number;
}

/** The first period: the full monthly amount is charged (money.md), and the period starts. */
export function ledgerRowsForActivation(args: { operationId: string; periodId: string; entitlements: Entitlements }): LedgerRow[] {
  assertEntitlements(args.entitlements);
  const monthly = monthlyCents(args.entitlements);
  return [
    { operationId: args.operationId, entryType: 'period_start', sequence: 1, amountCents: 0, periodId: args.periodId, plan: args.entitlements.plan, seats: args.entitlements.seats, paidBasisAfterCents: monthly },
    { operationId: args.operationId, entryType: 'charge', sequence: 1, amountCents: monthly, periodId: args.periodId, plan: null, seats: null, paidBasisAfterCents: null },
  ];
}

/**
 * The rows an applied change writes. A paid change writes a credit for the unused part of what the period already paid, a charge for the new
 * amount over the days left (their sum is the payment), and the entitlement change. A change that is free writes only the entitlement change.
 * A change that only schedules a decrease writes nothing yet: the scheduled change itself gets a ledger type with the slice that builds it.
 */
export function ledgerRowsForChange(args: { operationId: string; periodId: string; quote: ChangeQuote }): LedgerRow[] {
  const { operationId, periodId, quote } = args;
  if (quote.kind === 'none' || quote.kind === 'scheduled_only') return [];
  const rows: LedgerRow[] = [];
  if (quote.kind === 'paid' && quote.calculation) {
    if (quote.calculation.creditCents > 0) rows.push({ operationId, entryType: 'credit', sequence: 1, amountCents: -quote.calculation.creditCents, periodId, plan: null, seats: null, paidBasisAfterCents: null });
    rows.push({ operationId, entryType: 'charge', sequence: 1, amountCents: quote.calculation.grossChargeCents, periodId, plan: null, seats: null, paidBasisAfterCents: null });
  }
  rows.push({ operationId, entryType: 'entitlement_change', sequence: 1, amountCents: 0, periodId, plan: quote.applyNow.plan, seats: quote.applyNow.seats, paidBasisAfterCents: quote.paidBasisAfterCents });
  return rows;
}

/** Folds rows (oldest first) into the subscription state. Throws when the rows could not have produced a state: that is a corrupt ledger. */
export function rebuildSubscription(rows: readonly LedgerRow[]): SubscriptionState {
  let state = null as Omit<SubscriptionState, 'version'> | null;
  const operations = new Set<string>();
  for (const row of rows) {
    if (!STATE_ENTRY_TYPES.includes(row.entryType)) continue;
    if (row.plan === null || row.seats === null || row.paidBasisAfterCents === null) throw new BillingInputError(`ledger row ${row.entryType} lacks its state`);
    if (row.entryType === 'period_start') {
      if (row.periodId === null) throw new BillingInputError('a period_start row needs its period');
      state = { plan: row.plan, seats: row.seats, paidBasisCents: row.paidBasisAfterCents, currentPeriodId: row.periodId };
    } else {
      if (state === null) throw new BillingInputError('an entitlement change came before any period started');
      state = { ...state, plan: row.plan, seats: row.seats, paidBasisCents: row.paidBasisAfterCents };
    }
    operations.add(row.operationId);
  }
  if (state === null) throw new BillingInputError('the ledger has no period_start: the subscription never activated');
  return { ...state, version: operations.size };
}

/** Signed sum of the money rows: what the team has paid in net (charges, less credits and refunds, plus corrections). */
export function netPaidCents(rows: readonly LedgerRow[]): number {
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

/** The state a stored subscription should have after an applied change; the tests check it against `rebuildSubscription`. */
export function applyQuoteToState(state: SubscriptionState, quote: ChangeQuote): SubscriptionState {
  if (quote.kind === 'none' || quote.kind === 'scheduled_only') return state;
  return { ...state, plan: quote.applyNow.plan, seats: quote.applyNow.seats, paidBasisCents: quote.paidBasisAfterCents, version: state.version + 1 };
}
