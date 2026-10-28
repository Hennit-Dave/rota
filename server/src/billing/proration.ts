// Proration: the one place a charge is calculated (money.md). Pure and exact: integer cents, BigInt for the multiply-then-divide, no floating point.
// The app never repeats any of this; it shows the finished figures the server returns.
import { assertEntitlements, BillingInputError, monthlyCents, PLANS, sameEntitlements, type Entitlements } from './plans.js';

/**
 * The smallest amount Stripe will collect in USD: 0.50 USD ([Stripe, currencies](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts)).
 * A paid increase whose charge would be smaller is applied immediately instead, with no charge and `paid_basis` unchanged (Dave, 2026-10-28; money.md).
 */
export const MIN_CHARGE_CENTS = 50;

function assertCents(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new BillingInputError(`${name} must be a non-negative integer number of cents`);
}

/**
 * floor(amount x remaining / periodDays): multiply first, then divide, in integers. BigInt division truncates, which is floor for non-negative values.
 * periodDays is the period row's own length (28 to 31), never a literal.
 */
export function proratedCents(amountCents: number, remainingDays: number, periodDays: number): number {
  assertCents('amount', amountCents);
  if (!Number.isSafeInteger(periodDays) || periodDays < 28 || periodDays > 31) throw new BillingInputError('a period is 28 to 31 days');
  if (!Number.isSafeInteger(remainingDays) || remainingDays < 1 || remainingDays > periodDays) throw new BillingInputError('remaining days must be between 1 and the period length');
  return Number((BigInt(amountCents) * BigInt(remainingDays)) / BigInt(periodDays));
}

export type ChangeKind =
  /** The target is what the team already has. */
  | 'none'
  /** Only decreases: nothing changes now and nothing is charged; the target applies at the end of the period. */
  | 'scheduled_only'
  /** Applies now, no payment: it does not raise the amount this period is paid at, or the charge would be under Stripe's minimum (MIN_CHARGE_CENTS). */
  | 'immediate'
  /** Applies after a verified payment: the increase raises the amount above `paid_basis`. */
  | 'paid';

export interface ChangeInput {
  current: Entitlements;
  target: Entitlements;
  /** The monthly amount this period has been paid at. Read from the database, never from the client. */
  paidBasisCents: number;
  periodDays: number;
  /** remaining = period_days - d + 1 (periods.ts). */
  remainingDays: number;
}

/** How a paid change was calculated. Stored with the payment operation and written to the ledger as a credit and a charge. */
export interface Calculation {
  /** Monthly amount of the entitlements after the increase. */
  newMonthlyCents: number;
  paidBasisCents: number;
  remainingDays: number;
  periodDays: number;
  /** floor(new_monthly x remaining / period_days): the cost of the new amount for the days left. */
  grossChargeCents: number;
  /** floor(paid_basis x remaining / period_days): the unused part of what this period already paid. */
  creditCents: number;
}

export interface ChangeQuote {
  kind: ChangeKind;
  /** The entitlements in force right after the change applies (after payment, for a paid change). */
  applyNow: Entitlements;
  /** The entitlements that apply at the end of the period, or null. Decreases are never applied mid-period, even when they cost more. */
  atPeriodEnd: Entitlements | null;
  /** What to collect today: gross - credit. 0 unless kind is 'paid'. */
  chargeCents: number;
  /** The amount this period is paid at once the change has applied. */
  paidBasisAfterCents: number;
  /** The monthly amount of the entitlements after any scheduled change: what the next renewal charges. */
  nextRenewalCents: number;
  /** Present only for a change that is paid (or would be paid). */
  calculation: Calculation | null;
}

/**
 * Splits a change into its increases (now) and its decreases (at the end of the period), then prices the part that applies now.
 * Plan and seats are separate dimensions: a higher tier applies now, a lower tier waits; more seats apply now, fewer wait.
 * "Higher tier" is not "costs more": the amount is compared with `paid_basis`, not with the old plan (money.md).
 */
export function quoteChange(input: ChangeInput): ChangeQuote {
  const { current, target, paidBasisCents, periodDays, remainingDays } = input;
  assertEntitlements(current);
  assertEntitlements(target);
  assertCents('paid basis', paidBasisCents);

  if (sameEntitlements(current, target)) {
    return { kind: 'none', applyNow: current, atPeriodEnd: null, chargeCents: 0, paidBasisAfterCents: paidBasisCents, nextRenewalCents: monthlyCents(current), calculation: null };
  }

  const currentTier = PLANS[current.plan].tier;
  const targetTier = PLANS[target.plan].tier;
  const applyNow: Entitlements = {
    plan: targetTier > currentTier ? target.plan : current.plan,
    seats: target.seats > current.seats ? target.seats : current.seats,
  };
  const atPeriodEnd = sameEntitlements(applyNow, target) ? null : target;
  const nextRenewalCents = monthlyCents(atPeriodEnd ?? applyNow);

  // Only decreases: nothing applies now.
  if (sameEntitlements(applyNow, current)) {
    return { kind: 'scheduled_only', applyNow: current, atPeriodEnd, chargeCents: 0, paidBasisAfterCents: paidBasisCents, nextRenewalCents, calculation: null };
  }

  // Raises the paid amount: the immediate part is priced with the formula. (If a mixed change's immediate state costs no more than the paid basis, it is free.)
  const newMonthlyCents = monthlyCents(applyNow);
  if (newMonthlyCents <= paidBasisCents) {
    return { kind: 'immediate', applyNow, atPeriodEnd, chargeCents: 0, paidBasisAfterCents: paidBasisCents, nextRenewalCents, calculation: null };
  }
  const grossChargeCents = proratedCents(newMonthlyCents, remainingDays, periodDays);
  const creditCents = proratedCents(paidBasisCents, remainingDays, periodDays);
  // Under Stripe's minimum nothing can be collected: apply now, charge nothing, leave paid_basis alone. The charge is never raised to the minimum.
  // The cost is the few cents for the days until the next paid change or renewal: because paid_basis stays, a later paid change is priced exactly as if
  // this one had not happened, so nothing is ever charged twice either.
  if (grossChargeCents - creditCents < MIN_CHARGE_CENTS) {
    return { kind: 'immediate', applyNow, atPeriodEnd, chargeCents: 0, paidBasisAfterCents: paidBasisCents, nextRenewalCents, calculation: null };
  }
  return {
    kind: 'paid',
    applyNow,
    atPeriodEnd,
    chargeCents: grossChargeCents - creditCents,
    paidBasisAfterCents: newMonthlyCents,
    nextRenewalCents,
    calculation: { newMonthlyCents, paidBasisCents, remainingDays, periodDays, grossChargeCents, creditCents },
  };
}
