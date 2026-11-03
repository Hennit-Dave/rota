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
  /** A payment that is still open (waiting or being confirmed), or null. */
  openOperation: Operation | null;
  /** The reduction the Owner scheduled for the end of the period, or null (ADR 0029). */
  scheduledChange: ScheduledChange | null;
  /** The card saved for renewals, as finished strings, or null (ADR 0030). The app never holds a Stripe id. */
  savedCard: SavedCard | null;
  /** What the Owner agrees to by saving a card now: the server's wording, shown before Stripe's page opens. Null until the team has a subscription. */
  cardConsentWording: string | null;
  /** Something is wrong with the renewal (past due, read-only, being confirmed, under review), or null when all is well (ADR 0031). */
  renewal: Renewal | null;
}

export type RenewalState = 'confirming' | 'past_due' | 'read_only' | 'review';
const RENEWAL_STATES: readonly string[] = ['confirming', 'past_due', 'read_only', 'review'];

/** The renewal as the server words it. Every string is finished (the amount, the date, the reason); `canRetry` and `readOnly` are the server's decisions. */
export interface Renewal {
  state: RenewalState;
  readOnly: boolean;
  headline: string;
  detail: string;
  amountDisplay: string | null;
  graceEndsOn: string | null;
  canRetry: boolean;
}

export function parseRenewal(v: unknown): Renewal | null {
  if (v === null || v === undefined) return null;
  if (!isRecord(v) || typeof v.state !== 'string' || !RENEWAL_STATES.includes(v.state) || typeof v.readOnly !== 'boolean') throw unreadable();
  if (typeof v.headline !== 'string' || typeof v.detail !== 'string' || typeof v.canRetry !== 'boolean') throw unreadable();
  if ((v.amountDisplay !== null && typeof v.amountDisplay !== 'string') || (v.graceEndsOn !== null && !isDate(v.graceEndsOn))) throw unreadable();
  return { state: v.state as RenewalState, readOnly: v.readOnly, headline: v.headline, detail: v.detail, amountDisplay: v.amountDisplay, graceEndsOn: v.graceEndsOn, canRetry: v.canRetry };
}

/** `{ renewal }` as POST /renewal/retry answers (202): the renewal now "confirming". */
export function parseRetryAnswer(body: unknown): Renewal {
  const renewal = isRecord(body) ? parseRenewal(body.renewal) : null;
  if (renewal === null) throw unreadable();
  return renewal;
}

export interface SavedCard {
  /** "Visa ending 4242". */
  summary: string;
  /** "Expires 08/2027". */
  expiresDisplay: string;
  /** The wording the Owner agreed to, as shown on Stripe's page. */
  consentWording: string;
  /** The UTC day the agreement was recorded, `YYYY-MM-DD`. */
  consentedOn: string;
}

export type ScheduledStatus = 'scheduled' | 'ready' | 'blocked' | 'continuing';
const SCHEDULED_STATUSES: readonly string[] = ['scheduled', 'ready', 'blocked', 'continuing'];

/** A decrease that takes effect when the period ends. `message` is the server's sentence; `canCancel` is the server's decision. */
export interface ScheduledChange {
  id: string;
  status: ScheduledStatus;
  targetPlan: PlanId;
  targetPlanName: string;
  targetSeats: number;
  effectiveOn: string;
  membersToDeactivate: Array<{ userId: string; name: string }>;
  fallbackAccepted: boolean;
  fallbackWording: string | null;
  message: string;
  canCancel: boolean;
}

export function parseScheduledChange(v: unknown): ScheduledChange {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.status !== 'string' || !SCHEDULED_STATUSES.includes(v.status)) throw unreadable();
  if (!isPlan(v.targetPlan) || typeof v.targetPlanName !== 'string' || !isCount(v.targetSeats) || !isDate(v.effectiveOn) || !Array.isArray(v.membersToDeactivate)) throw unreadable();
  if (typeof v.fallbackAccepted !== 'boolean' || (v.fallbackWording !== null && typeof v.fallbackWording !== 'string') || typeof v.message !== 'string' || typeof v.canCancel !== 'boolean') throw unreadable();
  const membersToDeactivate = v.membersToDeactivate.map((m: unknown) => {
    if (!isRecord(m) || typeof m.userId !== 'string' || typeof m.name !== 'string') throw unreadable();
    return { userId: m.userId, name: m.name };
  });
  return {
    id: v.id,
    status: v.status as ScheduledStatus,
    targetPlan: v.targetPlan,
    targetPlanName: v.targetPlanName,
    targetSeats: v.targetSeats,
    effectiveOn: v.effectiveOn,
    membersToDeactivate,
    fallbackAccepted: v.fallbackAccepted,
    fallbackWording: v.fallbackWording,
    message: v.message,
    canCancel: v.canCancel,
  };
}

/** `{ status: 'scheduled', scheduledChange }` as POST /reductions answers. */
export function parseScheduleAnswer(body: unknown): ScheduledChange {
  if (!isRecord(body) || body.status !== 'scheduled') throw unreadable();
  return parseScheduledChange(body.scheduledChange);
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
  /** What the Owner agrees to by paying (it also saves the card for renewals): the server's wording, the same text Stripe's page shows. */
  consentWording: string;
}

export type OperationStatus = 'awaiting_payment' | 'confirming' | 'paid' | 'failed' | 'expired' | 'under_review';
const STATUSES: readonly string[] = ['awaiting_payment', 'confirming', 'paid', 'failed', 'expired', 'under_review'];

export interface Operation {
  id: string;
  /** `activation` is the first payment; `change` is a paid plan or seat change (ADR 0028). */
  kind: 'activation' | 'change';
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
  const openOperation = body.openOperation === null || body.openOperation === undefined ? null : parseOperation(body.openOperation);
  const scheduledChange = body.scheduledChange === null || body.scheduledChange === undefined ? null : parseScheduledChange(body.scheduledChange);
  if (body.cardConsentWording !== null && typeof body.cardConsentWording !== 'string') throw unreadable();
  const savedCard = parseSavedCard(body.savedCard);
  return { testModeNotice: body.testModeNotice, activated: body.activated, plans: body.plans.map(parsePlan), subscription, members: body.members, seatLimit: body.seatLimit, openOperation, scheduledChange, savedCard, cardConsentWording: body.cardConsentWording, renewal: parseRenewal(body.renewal) };
}

function parseSavedCard(v: unknown): SavedCard | null {
  if (v === null) return null;
  if (!isRecord(v) || typeof v.summary !== 'string' || typeof v.expiresDisplay !== 'string' || typeof v.consentWording !== 'string' || !isDate(v.consentedOn)) throw unreadable();
  return { summary: v.summary, expiresDisplay: v.expiresDisplay, consentWording: v.consentWording, consentedOn: v.consentedOn };
}

export function parseQuote(body: unknown): ActivationQuote {
  const q = isRecord(body) ? body.quote : null;
  if (!isRecord(q) || !isPlan(q.plan) || typeof q.planName !== 'string' || !isCount(q.seats) || typeof q.chargeTodayDisplay !== 'string') throw unreadable();
  if (!isDate(q.periodStartsOn) || !isDate(q.periodEndsOn) || typeof q.note !== 'string' || typeof q.testModeNotice !== 'string' || typeof q.consentWording !== 'string') throw unreadable();
  return { plan: q.plan, planName: q.planName, seats: q.seats, chargeTodayDisplay: q.chargeTodayDisplay, periodStartsOn: q.periodStartsOn, periodEndsOn: q.periodEndsOn, note: q.note, testModeNotice: q.testModeNotice, consentWording: q.consentWording };
}

export function parseOperation(v: unknown): Operation {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.status !== 'string' || !STATUSES.includes(v.status)) throw unreadable();
  if (!isPlan(v.plan) || typeof v.planName !== 'string' || !isCount(v.seats) || typeof v.amountDisplay !== 'string' || typeof v.expiresAt !== 'string') throw unreadable();
  const kind = v.kind === 'change' ? 'change' : 'activation';
  return { id: v.id, kind, status: v.status as OperationStatus, plan: v.plan, planName: v.planName, seats: v.seats, amountDisplay: v.amountDisplay, expiresAt: v.expiresAt };
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

// ---- Plan and seat changes (ADR 0028) ----

export type ChangeEffect = 'none' | 'now' | 'after_payment' | 'at_period_end' | 'mixed';
const EFFECTS: readonly string[] = ['none', 'now', 'after_payment', 'at_period_end', 'mixed'];

export interface EntitlementView {
  plan: PlanId;
  planName: string;
  seats: number;
}

/** What a change would cost and when it takes effect. Every figure is the server's finished text; `supported: false` means the server offers no button. */
export interface ChangeQuote {
  effect: ChangeEffect;
  supported: boolean;
  current: EntitlementView;
  applyNow: EntitlementView;
  atPeriodEnd: EntitlementView | null;
  chargeTodayDisplay: string | null;
  nextRenewalDisplay: string;
  remainingDays: number;
  periodEndsOn: string;
  headline: string;
  /** Present for a decrease: the date it takes effect, how many people the Owner must choose, and the fallback wording to show. Otherwise null. */
  reduction: ReductionQuote | null;
  testModeNotice: string;
}

export interface ReductionQuote {
  effectiveOn: string;
  activeMembers: number;
  membersToDeactivate: number;
  fallbackWording: string;
}

function parseReductionQuote(v: unknown): ReductionQuote | null {
  if (v === null || v === undefined) return null;
  if (!isRecord(v) || !isDate(v.effectiveOn) || !isCount(v.activeMembers) || !isCount(v.membersToDeactivate) || typeof v.fallbackWording !== 'string') throw unreadable();
  return { effectiveOn: v.effectiveOn, activeMembers: v.activeMembers, membersToDeactivate: v.membersToDeactivate, fallbackWording: v.fallbackWording };
}

function parseEntitlement(v: unknown): EntitlementView {
  if (!isRecord(v) || !isPlan(v.plan) || typeof v.planName !== 'string' || !isCount(v.seats)) throw unreadable();
  return { plan: v.plan, planName: v.planName, seats: v.seats };
}

export function parseChangeQuote(body: unknown): ChangeQuote {
  const q = isRecord(body) ? body.quote : null;
  if (!isRecord(q) || typeof q.effect !== 'string' || !EFFECTS.includes(q.effect) || typeof q.supported !== 'boolean') throw unreadable();
  if (q.chargeTodayDisplay !== null && typeof q.chargeTodayDisplay !== 'string') throw unreadable();
  if (typeof q.nextRenewalDisplay !== 'string' || !isCount(q.remainingDays) || !isDate(q.periodEndsOn) || typeof q.headline !== 'string' || typeof q.testModeNotice !== 'string') throw unreadable();
  return {
    effect: q.effect as ChangeEffect,
    supported: q.supported,
    current: parseEntitlement(q.current),
    applyNow: parseEntitlement(q.applyNow),
    atPeriodEnd: q.atPeriodEnd === null ? null : parseEntitlement(q.atPeriodEnd),
    chargeTodayDisplay: q.chargeTodayDisplay,
    nextRenewalDisplay: q.nextRenewalDisplay,
    remainingDays: q.remainingDays,
    periodEndsOn: q.periodEndsOn,
    headline: q.headline,
    reduction: parseReductionQuote(q.reduction),
    testModeNotice: q.testModeNotice,
  };
}

/** The answer to "make this change": it was applied at once (no payment), or a payment is needed and Stripe's page is the next step. */
export type ChangeAnswer =
  | { status: 'applied'; change: EntitlementView & { message: string; nextRenewalDisplay: string; periodEndsOn: string } }
  | { status: 'payment_required'; operation: Operation; checkoutUrl: string };

export function parseChangeAnswer(body: unknown): ChangeAnswer {
  if (!isRecord(body)) throw unreadable();
  if (body.status === 'payment_required') return { status: 'payment_required', ...parseStartResponse(body) };
  if (body.status !== 'applied' || !isRecord(body.change)) throw unreadable();
  const c = body.change;
  if (typeof c.message !== 'string' || typeof c.nextRenewalDisplay !== 'string' || !isDate(c.periodEndsOn)) throw unreadable();
  return { status: 'applied', change: { ...parseEntitlement(c), message: c.message, nextRenewalDisplay: c.nextRenewalDisplay, periodEndsOn: c.periodEndsOn } };
}

export interface HistoryLine {
  label: string;
  amountDisplay: string;
}

export interface HistoryEntry {
  id: string;
  date: string;
  title: string;
  detail: string | null;
  netDisplay: string;
  lines: HistoryLine[];
}

export function parseHistory(body: unknown): { history: HistoryEntry[]; hasMore: boolean } {
  if (!isRecord(body) || !Array.isArray(body.history) || typeof body.hasMore !== 'boolean') throw unreadable();
  const history = body.history.map((e: unknown): HistoryEntry => {
    if (!isRecord(e) || typeof e.id !== 'string' || !isDate(e.date) || typeof e.title !== 'string' || typeof e.netDisplay !== 'string' || !Array.isArray(e.lines)) throw unreadable();
    if (e.detail !== null && typeof e.detail !== 'string') throw unreadable();
    const lines = e.lines.map((l: unknown): HistoryLine => {
      if (!isRecord(l) || typeof l.label !== 'string' || typeof l.amountDisplay !== 'string') throw unreadable();
      return { label: l.label, amountDisplay: l.amountDisplay };
    });
    return { id: e.id, date: e.date, title: e.title, detail: e.detail, netDisplay: e.netDisplay, lines };
  });
  return { history, hasMore: body.hasMore };
}

export const historyKey = (userId: string, teamId: string) => ['billing', userId, teamId, 'history'] as const;

// ---- Saving a card (ADR 0030) ----

export type CardSetupStatus = 'awaiting_card' | 'confirming' | 'saved' | 'failed' | 'expired' | 'under_review';
const CARD_SETUP_STATUSES: readonly string[] = ['awaiting_card', 'confirming', 'saved', 'failed', 'expired', 'under_review'];

/** One attempt to save a card. The status is the server's decision; the app only picks the screen. */
export interface CardSetup {
  id: string;
  status: CardSetupStatus;
  expiresAt: string;
}

export function parseCardSetup(v: unknown): CardSetup {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.status !== 'string' || !CARD_SETUP_STATUSES.includes(v.status) || typeof v.expiresAt !== 'string') throw unreadable();
  return { id: v.id, status: v.status as CardSetupStatus, expiresAt: v.expiresAt };
}

/** `{ setup }` as GET and cancel answer. */
export function parseCardSetupResponse(body: unknown): CardSetup {
  if (!isRecord(body)) throw unreadable();
  return parseCardSetup(body.setup);
}

/** `{ status: 'card_setup_required', setup, checkoutUrl }` as POST /card/setup answers. */
export function parseCardSetupStart(body: unknown): { setup: CardSetup; checkoutUrl: string } {
  if (!isRecord(body) || body.status !== 'card_setup_required' || !isStripeCheckoutUrl(body.checkoutUrl)) throw unreadable();
  return { setup: parseCardSetup(body.setup), checkoutUrl: body.checkoutUrl };
}

/** True once the server has decided: the screen stops asking. */
export function isCardSetupSettled(status: CardSetupStatus): boolean {
  return status === 'saved' || status === 'failed' || status === 'expired' || status === 'under_review';
}

export const cardSetupKey = (userId: string, teamId: string, setupId: string) => ['billing', userId, teamId, 'card-setup', setupId] as const;
