// The plan catalogue. Prices live ONLY here, on the server (money.md): the app never holds a price, and Stripe only collects an amount we calculated.
// Integer US cents everywhere; no floating point.

export const PLAN_IDS = ['starter', 'team', 'business'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanTerms {
  /** 1 = lowest. A "higher tier" is a higher tier number, which is NOT the same as costing more (money.md). */
  tier: number;
  priceCents: number;
  includedSeats: number;
  /** null = extra seats are not available on this plan. */
  extraSeatCents: number | null;
}

export const PLANS: Readonly<Record<PlanId, PlanTerms>> = {
  starter: { tier: 1, priceCents: 2000, includedSeats: 5, extraSeatCents: null },
  team: { tier: 2, priceCents: 5000, includedSeats: 15, extraSeatCents: 300 },
  business: { tier: 3, priceCents: 12000, includedSeats: 40, extraSeatCents: 200 },
};

export const CURRENCY = 'usd';

/** What a team can use right now. Seats count every active member including the Owner. */
export interface Entitlements {
  plan: PlanId;
  seats: number;
}

export class BillingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingInputError';
  }
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

/** The reason these entitlements cannot exist, or null. Starter never exceeds its included seats; there is no other ceiling. */
export function entitlementsProblem(e: Entitlements): string | null {
  if (!isPlanId(e.plan)) return 'unknown_plan';
  if (!Number.isSafeInteger(e.seats) || e.seats < 1) return 'seats_must_be_a_positive_integer';
  const terms = PLANS[e.plan];
  if (terms.extraSeatCents === null && e.seats > terms.includedSeats) return 'seats_over_plan_limit';
  return null;
}

export function assertEntitlements(e: Entitlements): void {
  const problem = entitlementsProblem(e);
  if (problem) throw new BillingInputError(`${problem}: ${e.plan} with ${e.seats} seats`);
}

/** Monthly amount = plan price + max(0, seats - included) x extra-seat price (money.md). */
export function monthlyCents(e: Entitlements): number {
  assertEntitlements(e);
  const terms = PLANS[e.plan];
  const extra = Math.max(0, e.seats - terms.includedSeats);
  return terms.priceCents + (extra === 0 ? 0 : extra * (terms.extraSeatCents as number));
}

export function sameEntitlements(a: Entitlements, b: Entitlements): boolean {
  return a.plan === b.plan && a.seats === b.seats;
}
