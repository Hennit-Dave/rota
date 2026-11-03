// What a renewal means to the people in the team (ADR 0031): the plain-words reason, the banner the app shows, and whether the team is read-only.
// "Past due" and "read-only" are DERIVED from the `renewals` row at the moment of asking (never cached, AGENTS.md rule 11), so nothing can drift from it: a team is
// read-only exactly when its current period's renewal failed, the grace period has ended, and it has not been paid since.
import { getShard, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { formatUsd } from './display.js';
import { monthlyCents, type PlanId } from './plans.js';

type Db = Pick<PrismaClient, '$queryRaw'>;

/** The reason a renewal did not go through, in the Owner's words. Every code the job can store has a sentence; an unknown Stripe code gets the general one. */
export function failureSentence(code: string | null): string {
  switch (code) {
    case 'no_card':
      return 'Your team has no saved card, so we could not collect the renewal.';
    case 'reduction_blocked':
      return 'The reduction you scheduled could not be applied, because more people are still active than the smaller plan allows. Nothing was charged.';
    case 'authentication_required':
      return 'Your bank wants you to confirm the payment yourself, which it cannot do for a saved card. Replace the card, or ask your bank to allow the payment.';
    case 'expired_card':
      return 'Your saved card has expired.';
    case 'insufficient_funds':
      return 'Your card was declined for insufficient funds.';
    case 'charge_refused':
    case 'charge_unconfirmed':
      return 'We could not complete the charge of your saved card.';
    case 'card_declined':
    default:
      return 'Your card was declined.';
  }
}

export type RenewalViewState = 'confirming' | 'past_due' | 'read_only' | 'review';

/** The renewal as the Owner's billing screen shows it. Finished strings only: the app does no arithmetic and decides nothing (AGENTS.md rule 2). */
export interface RenewalView {
  state: RenewalViewState;
  /** True once the grace period has ended and the renewal is still not paid: nobody can change shifts, swaps or invitations. */
  readOnly: boolean;
  headline: string;
  detail: string;
  /** What the renewal charges, formatted by the server. */
  amountDisplay: string | null;
  /** The last day of full access, as a UTC calendar date, or null when nothing failed. */
  graceEndsOn: string | null;
  /** The Owner can press "Retry payment": only while the renewal is past due (not while a payment is being confirmed). */
  canRetry: boolean;
}

/** What the team's screens show, to everyone in it. The Owner gets the renewal's full words; everyone else is told only what changes for them. */
export interface TeamBillingNotice {
  state: RenewalViewState;
  readOnly: boolean;
  headline: string;
  detail: string;
}

export interface RenewalStateRow {
  status: 'scheduled' | 'retry_requested' | 'charging' | 'past_due' | 'paid' | 'needs_review';
  failure_code: string | null;
  failed_at: Date | null;
  grace_ends_at: Date | null;
  amount_cents: number | null;
  /** The subscription's own monthly amount, used when the renewal has not frozen one yet (a renewal that failed before any charge). */
  plan: PlanId;
  seats: number;
}

const utcDate = (d: Date) => d.toISOString().slice(0, 10);

/** Pure: the view of one renewal row at a moment, or null when nothing is wrong (a renewal that is simply waiting for its date). */
export function describeRenewal(row: RenewalStateRow | undefined, now: Date): RenewalView | null {
  if (!row || row.status === 'paid') return null;
  const failed = row.failed_at !== null && row.grace_ends_at !== null;
  const readOnly = failed && row.grace_ends_at!.getTime() <= now.getTime();
  if (!failed && row.status === 'scheduled') return null;

  const amountDisplay = formatUsd(row.amount_cents ?? monthlyCents({ plan: row.plan, seats: row.seats }));
  const graceEndsOn = failed ? utcDate(row.grace_ends_at!) : null;
  const sentence = failureSentence(row.failure_code);

  if (row.status === 'retry_requested' || row.status === 'charging') {
    return {
      state: 'confirming',
      readOnly,
      headline: 'Confirming your payment',
      detail: 'We have asked your card issuer to take the renewal and are waiting for its answer. This usually takes a few seconds.',
      amountDisplay,
      graceEndsOn,
      canRetry: false,
    };
  }
  if (row.status === 'needs_review') {
    return {
      state: 'review',
      readOnly,
      headline: 'We are checking your payment',
      detail: 'We received a payment that we could not match to your renewal. We are looking at it, and nothing more is charged meanwhile.',
      amountDisplay,
      graceEndsOn,
      canRetry: false,
    };
  }
  if (readOnly) {
    return {
      state: 'read_only',
      readOnly: true,
      headline: 'Your team is read-only',
      detail: `${sentence} Nobody can change shifts, swaps or invitations until the payment is made. Everyone can still sign in and look at their shifts, and you can still use Billing.`,
      amountDisplay,
      graceEndsOn,
      canRetry: true,
    };
  }
  return {
    state: 'past_due',
    readOnly: false,
    headline: 'Your renewal payment did not go through',
    detail: `${sentence} Your team keeps full access until ${graceEndsOn} (UTC). After that it becomes read-only until the payment is made.`,
    amountDisplay,
    graceEndsOn,
    canRetry: true,
  };
}

/** The renewal of the subscription's CURRENT period (the one that has ended or is ending), or undefined. Read from the primary, never cached. */
export async function loadRenewalState(db: Db, teamId: string): Promise<RenewalStateRow | undefined> {
  const rows = await db.$queryRaw<RenewalStateRow[]>`
    SELECT r.status::text AS status, r.failure_code, r.failed_at, r.grace_ends_at, r.amount_cents, s.plan::text AS plan, s.seats
    FROM renewals r JOIN subscriptions s ON s.team_id = r.team_id AND s.current_period_id = r.period_id
    WHERE r.team_id = ${teamId}::uuid`;
  return rows[0];
}

export async function getRenewalView(shards: Shards, teamId: string, now: Date = new Date()): Promise<RenewalView | null> {
  return describeRenewal(await loadRenewalState(getShard(shards, teamId).primary, teamId), now);
}

/** What the team's screens show: the Owner sees the renewal's words, everyone else sees a notice only once the team is read-only. */
export function noticeFor(view: RenewalView | null, role: 'owner' | 'manager' | 'staff'): TeamBillingNotice | null {
  if (!view) return null;
  if (role === 'owner') return { state: view.state, readOnly: view.readOnly, headline: view.headline, detail: view.detail };
  if (!view.readOnly) return null;
  return {
    state: 'read_only',
    readOnly: true,
    headline: 'This team is read-only',
    detail: 'Its payment is overdue, so nobody can change shifts, swaps or invitations for now. You can still sign in and look at your shifts. The Owner can fix this under Billing.',
  };
}

/**
 * Whether the team is read-only RIGHT NOW: its current period's renewal failed, the grace period has ended, and it has not been paid. One cheap query on the primary,
 * made by the write guard before every non-billing write (ADR 0031). It must not be cached: a payment confirmed a second ago lifts the restriction.
 */
export async function isTeamReadOnly(shards: Shards, teamId: string): Promise<boolean> {
  const rows = await getShard(shards, teamId).primary.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM renewals r JOIN subscriptions s ON s.team_id = r.team_id AND s.current_period_id = r.period_id
    WHERE r.team_id = ${teamId}::uuid AND r.failed_at IS NOT NULL AND r.grace_ends_at <= NOW() AND r.status <> 'paid'::renewal_status`;
  return rows.length > 0;
}
