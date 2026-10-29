// Display strings for money, made on the SERVER (AGENTS.md rule 2): the app only shows them and never divides a number of cents itself.
// Integer arithmetic only (BigInt): no floating point touches an amount.
import { BillingInputError, PLANS, type PlanId } from './plans.js';

/** 2000 -> "$20.00". Whole US cents in, a string out. */
export function formatUsd(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new BillingInputError('an amount to display must be a non-negative integer number of cents');
  const value = BigInt(cents);
  const dollars = value / 100n;
  const rest = value % 100n;
  return `$${dollars.toString()}.${rest.toString().padStart(2, '0')}`;
}

export const PLAN_NAMES: Readonly<Record<PlanId, string>> = { starter: 'Starter', team: 'Team', business: 'Business' };

export interface PlanOption {
  id: PlanId;
  name: string;
  priceDisplay: string;
  includedSeats: number;
  /** null: extra seats are not available on this plan. */
  extraSeatDisplay: string | null;
}

/** The plans the app offers, with every price already formatted. The app holds no price table (AGENTS.md rule 2). */
export function planOptions(): PlanOption[] {
  return (Object.keys(PLANS) as PlanId[]).map((id) => ({
    id,
    name: PLAN_NAMES[id],
    priceDisplay: formatUsd(PLANS[id].priceCents),
    includedSeats: PLANS[id].includedSeats,
    extraSeatDisplay: PLANS[id].extraSeatCents === null ? null : formatUsd(PLANS[id].extraSeatCents),
  }));
}

/** Shown wherever money is collected (AGENTS.md, Never). */
export const TEST_MODE_NOTICE = 'This integration uses Stripe test mode only. Live-payment eligibility has not been verified.';

/** Server-provided wording for the first period (money.md: the checkout summary says so). */
export const FIRST_PERIOD_NOTE = 'Your first billing period starts today (UTC) and is charged in full, even if you activate later in the day.';
