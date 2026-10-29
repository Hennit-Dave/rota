import { ApiError } from '../api/errors';

/**
 * What the billing endpoints answer (docs/ARCHITECTURE.md 5i, ADR 0027). EVERY figure here is a finished string made by the server ("$50.00"): the app
 * shows it and never divides, adds or compares an amount (AGENTS.md rule 2). The statuses are the server's decision; the app only picks screens.
 */
export type PlanId = 'starter' | 'team' | 'business';
export const PLAN_IDS: readonly PlanId[] = ['starter', 'team', 'business'];

export interface PlanOption {
  id: PlanId;
  name: string;
  priceDisplay: string;
  includedSeats: number;
  /** null: extra seats are not available on this plan. */
  extraSeatDisplay: string | null;
}

export interface BillingOverview {
  testModeNotice: string;
  activated: boolean;
  plans: PlanOption[];
  subscription: { plan: PlanId; planName: string; seats: number; monthlyDisplay: string; periodStartsOn: string; periodEndsOn: string } | null;
  members: number;
  seatLimit: number;
}

export interface ActivationQuote {
  plan: PlanId;
  planName: string;
  seats: number;
  chargeTodayDisplay: string;
  periodStartsOn: string;
  periodEndsOn: string;
  note: string;
  testModeNotice: string;
}

export type OperationStatus = 'awaiting_payment' | 'confirming' | 'paid' | 'failed' | 'expired' | 'under_review';
const STATUSES: readonly string[] = ['awaiting_payment', 'confirming', 'paid', 'failed', 'expired', 'under_review'];

export interface Operation {
  id: string;
  status: OperationStatus;
  plan: PlanId;
  planName: string;
  seats: number;
  amountDisplay: string;
  expiresAt: string;
}

const unreadable = () => new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPlan = (v: unknown): v is PlanId => typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function parsePlan(v: unknown): PlanOption {
  if (!isRecord(v) || !isPlan(v.id) || typeof v.name !== 'string' || typeof v.priceDisplay !== 'string' || !isCount(v.includedSeats)) throw unreadable();
  if (v.extraSeatDisplay !== null && typeof v.extraSeatDisplay !== 'string') throw unreadable();
  return { id: v.id, name: v.name, priceDisplay: v.priceDisplay, includedSeats: v.includedSeats, extraSeatDisplay: v.extraSeatDisplay };
}

export function parseOverview(body: unknown): BillingOverview {
  if (!isRecord(body) || typeof body.testModeNotice !== 'string' || typeof body.activated !== 'boolean' || !Array.isArray(body.plans)) throw unreadable();
  if (!isCount(body.members) || !isCount(body.seatLimit)) throw unreadable();
  let subscription: BillingOverview['subscription'] = null;
  if (body.subscription !== null) {
    const s = body.subscription;
    if (!isRecord(s) || !isPlan(s.plan) || typeof s.planName !== 'string' || !isCount(s.seats) || typeof s.monthlyDisplay !== 'string' || !isDate(s.periodStartsOn) || !isDate(s.periodEndsOn)) throw unreadable();
    subscription = { plan: s.plan, planName: s.planName, seats: s.seats, monthlyDisplay: s.monthlyDisplay, periodStartsOn: s.periodStartsOn, periodEndsOn: s.periodEndsOn };
  }
  if (body.activated !== (subscription !== null)) throw unreadable();
  return { testModeNotice: body.testModeNotice, activated: body.activated, plans: body.plans.map(parsePlan), subscription, members: body.members, seatLimit: body.seatLimit };
}

export function parseQuote(body: unknown): ActivationQuote {
  const q = isRecord(body) ? body.quote : null;
  if (!isRecord(q) || !isPlan(q.plan) || typeof q.planName !== 'string' || !isCount(q.seats) || typeof q.chargeTodayDisplay !== 'string') throw unreadable();
  if (!isDate(q.periodStartsOn) || !isDate(q.periodEndsOn) || typeof q.note !== 'string' || typeof q.testModeNotice !== 'string') throw unreadable();
  return { plan: q.plan, planName: q.planName, seats: q.seats, chargeTodayDisplay: q.chargeTodayDisplay, periodStartsOn: q.periodStartsOn, periodEndsOn: q.periodEndsOn, note: q.note, testModeNotice: q.testModeNotice };
}

export function parseOperation(v: unknown): Operation {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.status !== 'string' || !STATUSES.includes(v.status)) throw unreadable();
  if (!isPlan(v.plan) || typeof v.planName !== 'string' || !isCount(v.seats) || typeof v.amountDisplay !== 'string' || typeof v.expiresAt !== 'string') throw unreadable();
  return { id: v.id, status: v.status as OperationStatus, plan: v.plan, planName: v.planName, seats: v.seats, amountDisplay: v.amountDisplay, expiresAt: v.expiresAt };
}

/** `{ operation }` as GET and cancel answer. */
export function parseOperationResponse(body: unknown): Operation {
  if (!isRecord(body)) throw unreadable();
  return parseOperation(body.operation);
}

/** Stripe's Checkout page. The server sends the address, and the app still opens only an https address on stripe.com (a defence against a damaged answer). */
export function isStripeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

/** `{ operation, checkoutUrl }` as POST /activation answers. */
export function parseStartResponse(body: unknown): { operation: Operation; checkoutUrl: string } {
  if (!isRecord(body) || !isStripeCheckoutUrl(body.checkoutUrl)) throw unreadable();
  return { operation: parseOperation(body.operation), checkoutUrl: body.checkoutUrl };
}

/** True while the server is still deciding: the screen keeps asking. */
export function isSettled(status: OperationStatus): boolean {
  return status === 'paid' || status === 'failed' || status === 'expired' || status === 'under_review';
}

/** Personal, team-scoped server data: the keys carry the user and the team (app-state.md). Never persisted, never cached long (a payment status must not be stale). */
export const billingKey = (userId: string, teamId: string) => ['billing', userId, teamId] as const;
export const operationKey = (userId: string, teamId: string, operationId: string) => ['billing', userId, teamId, 'operation', operationId] as const;
