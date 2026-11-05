// Renewals (ADR 0031, payments slice P6b; money.md "Renewals and failed renewals"; the money-and-proration and background-job skills).
//
// At the end of every period the team is charged for the next one, using the card saved in P6a, and the new period starts. In plain words:
//   1. A renewal is a row (one per team per period) with a work row that fires at the period's end (00:00 UTC). `scheduleRenewal` writes both together.
//   2. The job FREEZES the attempt in one transaction (the team locked): the scheduled reduction is checked first, then the monthly amount of the entitlements the new
//      period will have is worked out by OUR engine, and the card is found. No card, or a reduction that cannot be applied, means no charge: the renewal fails.
//   3. After that commits, the job makes ONE Stripe call: charge the saved card, off-session, with a key that is stable per attempt. Its answer is NOT the outcome.
//   4. Only the VERIFIED WEBHOOK for the PaymentIntent decides (AGENTS.md rule 7). Success: one transaction applies the reduction, starts the next period, writes the
//      ledger rows, moves the subscription, marks the renewal paid and schedules the next renewal. Failure: the renewal is past due and the grace period begins.
//   5. No automatic retries (Dave). The Owner presses "Retry payment", which is a new attempt with a new key.
// Everything that decides whether a team is past due or read-only is derived from the `renewals` row (renewalState.ts); nothing is cached.
import { z } from 'zod';
import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { CANONICAL_UUID, shardFor, type ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { WORK_MAX_ATTEMPTS } from '../jobs/config.js';
import { TerminalJobError, type JobHandler } from '../jobs/worker.js';
import { loadSubscriptionState } from './changes.js';
import { CURRENCY, entitlementsProblem, monthlyCents, type Entitlements, type PlanId } from './plans.js';
import { StripeCardDeclinedError, StripeRejectedError, StripeUncertainError, type StripeGateway } from './gateway.js';
import { ledgerRowsForRenewal } from './ledger.js';
import { insertLedgerRows } from './ledgerDb.js';
import { periodAfter } from './periods.js';
import { graceEndsAt as graceEnd } from './renewalConfig.js';
import { insertWorkRow, queueOwnerNotices, type NewWork, type OwnerContact, type Sender } from './renewalNotice.js';
import { getRenewalView, type RenewalView } from './renewalState.js';
import { boundaryOutcome } from './reductions.js';
import type { RenewalPaymentJobPayload } from './stripeEvent.js';

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export const RENEWAL_KIND = 'renewal';
export const renewalJobPayload = z.object({ teamId: z.string().regex(CANONICAL_UUID), renewalId: z.string().regex(CANONICAL_UUID) });

/** Enqueues ALREADY COMMITTED work rows. Never throws (see `enqueueCommittedRow`): a Valkey failure leaves a row for the sweep (jobs.md). */
export type EnqueueRow = (prisma: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => Promise<void>;

export interface RenewalDeps {
  shards: Shards;
  stripe: StripeGateway;
  graceDays: number;
  sender: Sender;
  enqueue?: EnqueueRow;
  now?: () => Date;
}

export interface EventResult {
  outcome: 'applied' | 'duplicate' | 'review' | 'ignored';
  /** For the log only. Never shown to the app. */
  detail: string;
}

/** Stripe keeps an idempotency key for at least 24 hours (gateway.ts). Past 23 hours a resumed attempt is not repeated: it might create a SECOND payment. */
const RESUME_WINDOW_MS = 23 * 60 * 60 * 1000;
const TX_OPTIONS = { maxWait: 5000, timeout: 15_000 };

async function enqueueAll(deps: { shards: Shards; enqueue?: EnqueueRow }, teamId: string, rows: NewWork[]): Promise<void> {
  if (!deps.enqueue) return; // the sweep restores them (jobs.md)
  const prisma = getShard(deps.shards, teamId).primary;
  for (const row of rows) await deps.enqueue(prisma, row, shardFor(teamId));
}

// ---------------------------------------------------------------- scheduling

/**
 * Writes the renewal for a period and the work row that fires at its end, in the caller's transaction (which holds the team on its own shard). One renewal per team per
 * period (the unique index): asking twice writes nothing the second time and returns null. The caller enqueues the returned row AFTER the transaction commits.
 */
export async function scheduleRenewal(tx: Tx, input: { teamId: string; periodId: string; endsOn: string }): Promise<NewWork | null> {
  const dueAt = new Date(`${input.endsOn}T00:00:00.000Z`);
  const created = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO renewals (team_id, period_id, due_at) VALUES (${input.teamId}::uuid, ${input.periodId}::uuid, ${dueAt})
    ON CONFLICT (team_id, period_id) DO NOTHING RETURNING id::text AS id`;
  const renewalId = created[0]?.id;
  if (!renewalId) return null;
  return insertWorkRow(tx, RENEWAL_KIND, { teamId: input.teamId, renewalId }, dueAt);
}

/**
 * Makes sure every subscription has a renewal for its current period. A subscription that activated before this slice has none; the worker runs this when it starts. It
 * is idempotent and only ever ADDS a renewal where none exists. Skips a subscription whose team no longer exists (issue #71): a renewal for a gone team has no meaning.
 */
export async function ensureRenewals(shards: Shards, enqueue?: EnqueueRow, only?: { teamId: string }): Promise<number> {
  let made = 0;
  for (const shard of ['A', 'B'] as const) {
    const db = shards[shard].primary;
    // `only` narrows the check to one team (a test, or an operator fixing one subscription); without it every subscription on the shard is checked.
    const onlyTeam = only?.teamId ?? null;
    const missing = await db.$queryRaw<Array<{ team_id: string; period_id: string; ends_on: string }>>`
      SELECT s.team_id::text AS team_id, s.current_period_id::text AS period_id, p.ends_on::text AS ends_on
      FROM subscriptions s
      JOIN billing_periods p ON p.id = s.current_period_id
      JOIN teams t ON t.id = s.team_id
      WHERE (${onlyTeam}::uuid IS NULL OR s.team_id = ${onlyTeam}::uuid)
        AND NOT EXISTS (SELECT 1 FROM renewals r WHERE r.team_id = s.team_id AND r.period_id = s.current_period_id)`;
    for (const m of missing) {
      const work = await db.$transaction(async (tx) => scheduleRenewal(tx, { teamId: m.team_id, periodId: m.period_id, endsOn: m.ends_on }), TX_OPTIONS);
      if (work) {
        made += 1;
        await enqueue?.(db, work, shard);
      }
    }
  }
  return made;
}

// ---------------------------------------------------------------- shared steps

interface RenewalRow {
  id: string;
  period_id: string;
  status: 'scheduled' | 'retry_requested' | 'charging' | 'past_due' | 'paid' | 'needs_review';
  base_version: number | null;
  result_plan: PlanId | null;
  result_seats: number | null;
  scheduled_change_id: string | null;
  amount_cents: number | null;
  attempt_count: number;
  attempt_started_at: Date | null;
  stripe_payment_intent_id: string | null;
  failed_at: Date | null;
  grace_ends_at: Date | null;
}

const selectRenewal = (tx: Tx, renewalId: string, teamId: string) =>
  tx.$queryRaw<RenewalRow[]>`
    SELECT id::text AS id, period_id::text AS period_id, status::text AS status, base_version, result_plan::text AS result_plan, result_seats,
      scheduled_change_id::text AS scheduled_change_id, amount_cents, attempt_count, attempt_started_at, stripe_payment_intent_id, failed_at, grace_ends_at
    FROM renewals WHERE id = ${renewalId}::uuid AND team_id = ${teamId}::uuid FOR UPDATE`;

async function lockTeam(tx: Tx, teamId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
}

/** Stripe's error code, narrowed to something safe to store and show to a developer: lower-case words, or the general one. */
function failureCodeOf(raw: string | null | undefined): string {
  return raw && /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : 'payment_failed';
}

async function ownerContact(shards: Shards, teamId: string): Promise<OwnerContact | null> {
  const owner = await getShard(shards, teamId).primary.$queryRaw<Array<{ user_id: string }>>`
    SELECT user_id::text AS user_id FROM memberships WHERE team_id = ${teamId}::uuid AND role = 'owner'::team_role AND deactivated_at IS NULL LIMIT 1`;
  const userId = owner[0]?.user_id;
  if (!userId) return null;
  const user = await identityDb(shards).user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  return user ? { userId, email: user.email, name: user.name } : null;
}

interface FailureInput {
  teamId: string;
  renewal: RenewalRow;
  code: string;
  now: Date;
  graceDays: number;
  owner: OwnerContact | null;
  sender: Sender;
}

/**
 * Marks the renewal past due (the first failure starts the grace period; a later failure keeps it, so retrying cannot extend it) and, ONLY the first time, writes the
 * Owner's two notices in the same transaction. Returns the notice rows to enqueue after the commit.
 */
async function recordFailure(tx: Tx, input: FailureInput): Promise<NewWork[]> {
  const { renewal, now } = input;
  const first = renewal.failed_at === null;
  const failedAt = renewal.failed_at ?? now;
  const graceEndsAt = renewal.grace_ends_at ?? graceEnd(failedAt, input.graceDays);
  await tx.$executeRaw`
    UPDATE renewals SET status = 'past_due'::renewal_status, failure_code = ${input.code}, failed_at = ${failedAt}, grace_ends_at = ${graceEndsAt}, updated_at = NOW()
    WHERE id = ${renewal.id}::uuid AND team_id = ${input.teamId}::uuid AND status <> 'paid'::renewal_status`;
  if (!first) return [];
  if (!input.owner) {
    console.error(`[renewal] team_id=${input.teamId} renewal_id=${renewal.id} OWNER_NOT_NOTIFIED reason=no_owner_contact`);
    return [];
  }
  const team = await tx.$queryRaw<Array<{ name: string; time_zone: string }>>`SELECT name, time_zone FROM teams WHERE id = ${input.teamId}::uuid`;
  const amount = renewal.amount_cents ?? (await currentMonthly(tx, input.teamId));
  return queueOwnerNotices(
    tx,
    {
      teamId: input.teamId,
      teamName: team[0]?.name ?? 'Your team',
      timeZone: team[0]?.time_zone ?? 'UTC',
      owner: input.owner,
      sender: input.sender,
      renewalId: renewal.id,
      amountCents: amount,
      failureCode: input.code,
      graceEndsAt,
    },
    now,
  );
}

async function currentMonthly(tx: Tx, teamId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ plan: PlanId; seats: number }>>`SELECT plan::text AS plan, seats FROM subscriptions WHERE team_id = ${teamId}::uuid`;
  return rows[0] ? monthlyCents({ plan: rows[0].plan, seats: rows[0].seats }) : 0;
}

/** Records that a payment was taken but could not be applied: a human looks. Never raises, never applies. */
async function flagForReview(tx: Tx, teamId: string, renewalId: string, reason: string, paymentIntentId: string): Promise<EventResult> {
  await tx.$executeRaw`
    UPDATE renewals SET status = 'needs_review'::renewal_status, review_reason = ${`${reason} (payment ${paymentIntentId})`}, updated_at = NOW()
    WHERE id = ${renewalId}::uuid AND team_id = ${teamId}::uuid AND status <> 'paid'::renewal_status`;
  return { outcome: 'review', detail: reason };
}

// ---------------------------------------------------------------- the boundary: scheduled reduction

interface ScheduledRow {
  id: string;
  status: string;
  target_plan: PlanId;
  target_seats: number;
  selected: string[];
  fallback_accepted_at: Date | null;
}

type Resolution =
  | { kind: 'charge'; entitlements: Entitlements; scheduledChangeId: string | null }
  /** The reduction cannot be applied and the Owner did not accept the old price: collection pauses (money.md). */
  | { kind: 'paused' };

/**
 * "At the end: scheduled changes apply first, then the renewal charges the resulting monthly amount" (money.md). Re-checks the team's scheduled reduction against the
 * members as they are NOW (the authoritative check; it also records what it found, as the boundary job does), and says what the new period will be:
 *   fits            -> the smaller plan (applied only when the payment is confirmed);
 *   does not fit, Owner accepted the old price -> the current plan, charged as before ("continuing");
 *   does not fit, nothing accepted             -> paused: the old, higher price is NEVER charged silently, and the team follows the failed-renewal path.
 */
async function resolveBoundary(tx: Tx, teamId: string, current: Entitlements): Promise<Resolution> {
  const rows = await tx.$queryRaw<ScheduledRow[]>`
    SELECT id::text AS id, status::text AS status, target_plan::text AS target_plan, target_seats, selected_member_ids::text[] AS selected, fallback_accepted_at
    FROM scheduled_changes WHERE team_id = ${teamId}::uuid AND status::text = ANY(${['scheduled', 'ready', 'blocked', 'continuing']}::text[]) FOR UPDATE`;
  const change = rows[0];
  if (!change) return { kind: 'charge', entitlements: current, scheduledChangeId: null };

  const remaining = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM memberships WHERE team_id = ${teamId}::uuid AND deactivated_at IS NULL AND NOT (user_id = ANY(${change.selected}::uuid[]))`;
  const activeAfter = Number(remaining[0]?.n ?? 0);
  const outcome = boundaryOutcome({ activeAfter, targetSeats: change.target_seats, fallbackAccepted: change.fallback_accepted_at !== null });
  if (change.status !== outcome) {
    await tx.$executeRaw`
      UPDATE scheduled_changes SET status = ${outcome}::scheduled_change_status, checked_at = NOW(), check_detail = ${`active_after_${activeAfter}_target_${change.target_seats}`}, updated_at = NOW()
      WHERE id = ${change.id}::uuid`;
  }
  if (outcome === 'blocked') return { kind: 'paused' };
  if (outcome === 'continuing') return { kind: 'charge', entitlements: current, scheduledChangeId: null };
  const target: Entitlements = { plan: change.target_plan, seats: change.target_seats };
  if (entitlementsProblem(target)) return { kind: 'paused' }; // the database refuses such a row; this is the belt to those braces
  return { kind: 'charge', entitlements: target, scheduledChangeId: change.id };
}

// ---------------------------------------------------------------- the job: freeze an attempt, then charge

type Decision =
  | { kind: 'skip'; detail: string }
  | { kind: 'failed'; code: string; notices: NewWork[] }
  | { kind: 'charge'; attempt: number; amountCents: number; customerId: string; paymentMethodId: string };

interface ActiveCard {
  customer_id: string;
  payment_method_id: string;
}

const activeCardOf = async (tx: Tx, teamId: string): Promise<ActiveCard | undefined> =>
  (
    await tx.$queryRaw<ActiveCard[]>`
      SELECT stripe_customer_id AS customer_id, stripe_payment_method_id AS payment_method_id
      FROM team_payment_methods WHERE team_id = ${teamId}::uuid AND status = 'active'::saved_card_status`
  )[0];

async function decide(tx: Tx, deps: RenewalDeps, input: { teamId: string; renewalId: string; owner: OwnerContact | null }): Promise<Decision> {
  const now = (deps.now ?? (() => new Date()))();
  const { teamId } = input;
  await lockTeam(tx, teamId);
  const renewal = (await selectRenewal(tx, input.renewalId, teamId))[0];
  if (!renewal) return { kind: 'skip', detail: 'renewal_missing' };
  const fail = async (code: string): Promise<Decision> => ({
    kind: 'failed',
    code,
    notices: await recordFailure(tx, { teamId, renewal, code, now, graceDays: deps.graceDays, owner: input.owner, sender: deps.sender }),
  });

  if (renewal.status === 'paid' || renewal.status === 'past_due' || renewal.status === 'needs_review') return { kind: 'skip', detail: `status_${renewal.status}` };

  if (renewal.status === 'charging') {
    // A previous execution froze this attempt. If it already learned the PaymentIntent, only the webhook can move it on.
    if (renewal.stripe_payment_intent_id) return { kind: 'skip', detail: 'awaiting_webhook' };
    // Otherwise its Stripe call never finished (a crash, a timeout): repeat it with the SAME key, so Stripe returns the payment it already made. Past the key's life
    // (23 hours) repeating could charge twice, so the renewal fails for a human instead.
    if (renewal.attempt_started_at && now.getTime() - renewal.attempt_started_at.getTime() >= RESUME_WINDOW_MS) return fail('charge_unconfirmed');
    const card = await activeCardOf(tx, teamId);
    if (!card || renewal.amount_cents === null) return fail('charge_unconfirmed');
    return { kind: 'charge', attempt: renewal.attempt_count, amountCents: renewal.amount_cents, customerId: card.customer_id, paymentMethodId: card.payment_method_id };
  }

  // scheduled | retry_requested: start an attempt.
  const sub = await loadSubscriptionState(tx, teamId, true);
  if (!sub) return { kind: 'skip', detail: 'no_subscription' };
  if (sub.current_period_id !== renewal.period_id) return { kind: 'skip', detail: 'period_already_renewed' };

  const resolution = await resolveBoundary(tx, teamId, { plan: sub.plan, seats: sub.seats });
  if (resolution.kind === 'paused') return fail('reduction_blocked');
  const card = await activeCardOf(tx, teamId);
  if (!card) return fail('no_card');

  const amountCents = monthlyCents(resolution.entitlements);
  await tx.$executeRaw`
    UPDATE renewals SET status = 'charging'::renewal_status, base_version = ${sub.version}, result_plan = ${resolution.entitlements.plan}::billing_plan,
      result_seats = ${resolution.entitlements.seats}, scheduled_change_id = ${resolution.scheduledChangeId}::uuid, amount_cents = ${amountCents},
      attempt_count = attempt_count + 1, attempt_started_at = ${now}, stripe_payment_intent_id = NULL, updated_at = NOW()
    WHERE id = ${renewal.id}::uuid AND team_id = ${teamId}::uuid`;
  return { kind: 'charge', attempt: renewal.attempt_count + 1, amountCents, customerId: card.customer_id, paymentMethodId: card.payment_method_id };
}

/** Remembers the PaymentIntent of the attempt as soon as Stripe returns it (jobs.md). Only while the attempt is still charging and has none. */
async function recordIntent(team: PrismaClient, teamId: string, renewalId: string, paymentIntentId: string): Promise<void> {
  await team.$executeRaw`
    UPDATE renewals SET stripe_payment_intent_id = ${paymentIntentId}, updated_at = NOW()
    WHERE id = ${renewalId}::uuid AND team_id = ${teamId}::uuid AND status = 'charging'::renewal_status AND stripe_payment_intent_id IS NULL`;
}

async function failInTransaction(deps: RenewalDeps, teamId: string, renewalId: string, code: string, owner: OwnerContact | null): Promise<NewWork[]> {
  const now = (deps.now ?? (() => new Date()))();
  const team = getShard(deps.shards, teamId).primary;
  return team.$transaction(async (tx) => {
    await lockTeam(tx, teamId);
    const renewal = (await selectRenewal(tx, renewalId, teamId))[0];
    if (!renewal || renewal.status === 'paid' || renewal.status === 'needs_review') return [];
    return recordFailure(tx, { teamId, renewal, code, now, graceDays: deps.graceDays, owner, sender: deps.sender });
  }, TX_OPTIONS);
}

/**
 * The renewal job (jobs.md). It runs at the period's end for the first attempt and straight away for a retry the Owner asked for. It freezes the attempt, makes the ONE
 * Stripe call, and ends: it never records a payment outcome (rule 7). A crash anywhere is safe: a replay finds the attempt frozen and repeats the call with the same key.
 */
export function createRenewalHandler(deps: RenewalDeps): JobHandler {
  return async (ctx) => {
    const parsed = renewalJobPayload.safeParse(ctx.row.payload);
    if (!parsed.success) throw new TerminalJobError('invalid_payload');
    const { teamId, renewalId } = parsed.data;
    const logBase = `[renewal] row_id=${ctx.row.id} generation=${ctx.row.generation} origin_request_id=${ctx.row.originRequestId ?? '-'} team_id=${teamId} renewal_id=${renewalId}`;
    const team = getShard(deps.shards, teamId).primary;
    const owner = await ownerContact(deps.shards, teamId);

    const decision = await team.$transaction((tx) => decide(tx, deps, { teamId, renewalId, owner }), TX_OPTIONS);
    if (decision.kind === 'skip') {
      console.log(`${logBase} outcome=skipped detail=${decision.detail}`);
      return;
    }
    if (decision.kind === 'failed') {
      await enqueueAll(deps, teamId, decision.notices);
      console.warn(`${logBase} outcome=past_due detail=${decision.code} notices=${decision.notices.length}`);
      return;
    }

    // The attempt is frozen and committed. One Stripe call, with the lease renewed right before it (jobs.md).
    if (!(await ctx.renewLease())) throw new Error('work row ownership lost before the charge');
    try {
      const charge = await deps.stripe.createRenewalPayment({
        renewalId,
        teamId,
        attempt: decision.attempt,
        amountCents: decision.amountCents,
        customerId: decision.customerId,
        paymentMethodId: decision.paymentMethodId,
      });
      await recordIntent(team, teamId, renewalId, charge.paymentIntentId);
      console.log(`${logBase} outcome=charge_created attempt=${decision.attempt} payment_intent=${charge.paymentIntentId} stripe_status=${charge.status} awaiting=webhook`);
    } catch (err) {
      if (err instanceof StripeCardDeclinedError) {
        // The card was refused. Stripe made the PaymentIntent and will send payment_intent.payment_failed; that verified event records the failure. We only remember the id.
        if (err.paymentIntentId) await recordIntent(team, teamId, renewalId, err.paymentIntentId);
        console.warn(`${logBase} outcome=charge_declined attempt=${decision.attempt} code=${err.code} awaiting=webhook`);
        return;
      }
      if (err instanceof StripeRejectedError) {
        // Stripe refused the request, so no payment exists and no webhook will come: this is "no payment was taken", not a payment outcome.
        const notices = await failInTransaction(deps, teamId, renewalId, 'charge_refused', owner);
        await enqueueAll(deps, teamId, notices);
        console.warn(`${logBase} outcome=past_due detail=charge_refused reason=${err.reason}`);
        return;
      }
      if (err instanceof StripeUncertainError && ctx.row.executionAttempts >= WORK_MAX_ATTEMPTS) {
        // Out of attempts with the answer still unknown: fail the renewal for a human rather than leave it charging forever. If the payment did go through, its
        // webhook still arrives and is accepted (see `applySucceeded`).
        const notices = await failInTransaction(deps, teamId, renewalId, 'charge_unconfirmed', owner);
        await enqueueAll(deps, teamId, notices);
        console.error(`${logBase} outcome=past_due detail=charge_unconfirmed reason=${err.reason}`);
        return;
      }
      throw err; // uncertain: the processor releases the claim and BullMQ retries; the replay repeats the call with the same key
    }
  };
}

// ---------------------------------------------------------------- the webhook: only a verified event decides

interface Applied {
  result: EventResult;
  follow: NewWork[];
}

interface Subscription {
  plan: PlanId;
  seats: number;
  billing_anchor_day: number;
  version: number;
  current_period_id: string;
  ends_on: string;
}

/**
 * Applies a verified `payment_intent.succeeded` for a renewal, in ONE transaction on the team's shard: the scheduled reduction (members made inactive), the next period,
 * the ledger rows, the subscription, the renewal and the NEXT renewal. Every field must match what the attempt froze; anything else records the payment, applies nothing and
 * sends it to human review (money.md). The payment is accepted from any attempt of this renewal: it is money for exactly this renewal and amount.
 */
async function applySucceeded(deps: RenewalDeps, p: RenewalPaymentJobPayload): Promise<Applied> {
  const team = getShard(deps.shards, p.teamId).primary;
  return team.$transaction(async (tx): Promise<Applied> => {
    await lockTeam(tx, p.teamId);
    const renewal = (await selectRenewal(tx, p.renewalId, p.teamId))[0];
    if (!renewal) return { result: { outcome: 'review', detail: 'renewal_not_found' }, follow: [] };

    if (renewal.status === 'paid') {
      const same = renewal.stripe_payment_intent_id === p.paymentIntentId;
      return { result: same ? { outcome: 'duplicate', detail: 'payment_already_applied' } : { outcome: 'review', detail: 'renewal_paid_under_a_different_payment' }, follow: [] };
    }
    const flag = async (reason: string): Promise<Applied> => ({ result: await flagForReview(tx, p.teamId, renewal.id, reason, p.paymentIntentId), follow: [] });

    if (renewal.status === 'needs_review') return { result: { outcome: 'review', detail: 'renewal_already_in_review' }, follow: [] };
    if (renewal.amount_cents === null || !renewal.result_plan || renewal.result_seats === null || renewal.base_version === null) return flag('payment_without_a_frozen_attempt');
    if (p.status !== 'succeeded') return flag(`payment_status_${p.status ?? 'missing'}`);
    if (p.amount !== renewal.amount_cents) return flag('amount_mismatch');
    if (p.currency !== CURRENCY) return flag('currency_mismatch');

    const subRows = await tx.$queryRaw<Subscription[]>`
      SELECT s.plan::text AS plan, s.seats, s.billing_anchor_day, s.version, s.current_period_id::text AS current_period_id, p.ends_on::text AS ends_on
      FROM subscriptions s JOIN billing_periods p ON p.id = s.current_period_id WHERE s.team_id = ${p.teamId}::uuid FOR UPDATE OF s`;
    const sub = subRows[0];
    if (!sub) return flag('subscription_missing');
    if (sub.current_period_id !== renewal.period_id) return flag('period_changed');
    if (sub.version !== renewal.base_version) return flag('version_mismatch');

    // Our own engine re-derives the amount from the frozen entitlements; it must equal what was charged.
    const entitlements: Entitlements = { plan: renewal.result_plan, seats: renewal.result_seats };
    if (entitlementsProblem(entitlements) || monthlyCents(entitlements) !== renewal.amount_cents) return flag('amount_does_not_match_engine');

    // The reduction applies now, with the payment: the chosen people become inactive and the change is marked applied.
    if (renewal.scheduled_change_id) {
      const changes = await tx.$queryRaw<ScheduledRow[]>`
        SELECT id::text AS id, status::text AS status, target_plan::text AS target_plan, target_seats, selected_member_ids::text[] AS selected, fallback_accepted_at
        FROM scheduled_changes WHERE id = ${renewal.scheduled_change_id}::uuid AND team_id = ${p.teamId}::uuid FOR UPDATE`;
      const change = changes[0];
      if (!change || !['scheduled', 'ready'].includes(change.status)) return flag('scheduled_change_not_applicable');
      if (change.target_plan !== entitlements.plan || change.target_seats !== entitlements.seats) return flag('scheduled_change_differs_from_attempt');
      const remaining = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM memberships WHERE team_id = ${p.teamId}::uuid AND deactivated_at IS NULL AND NOT (user_id = ANY(${change.selected}::uuid[]))`;
      if (Number(remaining[0]?.n ?? 0) > change.target_seats) return flag('members_exceed_the_new_seats');
      await tx.$executeRaw`
        UPDATE memberships SET deactivated_at = NOW(), updated_at = NOW()
        WHERE team_id = ${p.teamId}::uuid AND user_id = ANY(${change.selected}::uuid[]) AND deactivated_at IS NULL AND role <> 'owner'::team_role`;
      await tx.$executeRaw`UPDATE scheduled_changes SET status = 'applied'::scheduled_change_status, updated_at = NOW() WHERE id = ${change.id}::uuid`;
    }

    const next = periodAfter(sub.ends_on, sub.billing_anchor_day);
    const periodRows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO billing_periods (team_id, starts_on, ends_on, period_days)
      VALUES (${p.teamId}::uuid, ${next.startsOn}::date, ${next.endsOn}::date, ${next.periodDays})
      ON CONFLICT (team_id, starts_on) DO UPDATE SET team_id = EXCLUDED.team_id RETURNING id::text AS id`;
    const nextPeriodId = periodRows[0]!.id;

    await insertLedgerRows(tx, p.teamId, ledgerRowsForRenewal({ operationId: renewal.id, periodId: nextPeriodId, entitlements }), p.paymentIntentId);
    await tx.$executeRaw`
      UPDATE subscriptions SET plan = ${entitlements.plan}::billing_plan, seats = ${entitlements.seats}, paid_basis_cents = ${renewal.amount_cents},
        version = version + 1, current_period_id = ${nextPeriodId}::uuid, updated_at = NOW()
      WHERE team_id = ${p.teamId}::uuid`;
    await tx.$executeRaw`
      UPDATE renewals SET status = 'paid'::renewal_status, stripe_payment_intent_id = ${p.paymentIntentId}, paid_at = NOW(), next_period_id = ${nextPeriodId}::uuid,
        updated_at = NOW()
      WHERE id = ${renewal.id}::uuid AND team_id = ${p.teamId}::uuid`;
    const upcoming = await scheduleRenewal(tx, { teamId: p.teamId, periodId: nextPeriodId, endsOn: next.endsOn });
    return { result: { outcome: 'applied', detail: 'renewal_paid' }, follow: upcoming ? [upcoming] : [] };
  }, TX_OPTIONS);
}

/** Applies a verified `payment_intent.payment_failed`: only for the attempt that is charging. A late event for an earlier attempt changes nothing. */
async function applyFailed(deps: RenewalDeps, p: RenewalPaymentJobPayload, owner: OwnerContact | null): Promise<Applied> {
  const team = getShard(deps.shards, p.teamId).primary;
  const now = (deps.now ?? (() => new Date()))();
  return team.$transaction(async (tx): Promise<Applied> => {
    await lockTeam(tx, p.teamId);
    const renewal = (await selectRenewal(tx, p.renewalId, p.teamId))[0];
    if (!renewal) return { result: { outcome: 'ignored', detail: 'renewal_not_found' }, follow: [] };
    if (renewal.status !== 'charging' || renewal.attempt_count !== p.attempt) return { result: { outcome: 'ignored', detail: `stale_failure_for_attempt_${p.attempt}` }, follow: [] };
    if (renewal.stripe_payment_intent_id === null) {
      await tx.$executeRaw`UPDATE renewals SET stripe_payment_intent_id = ${p.paymentIntentId}, updated_at = NOW() WHERE id = ${renewal.id}::uuid AND team_id = ${p.teamId}::uuid`;
    } else if (renewal.stripe_payment_intent_id !== p.paymentIntentId) return { result: { outcome: 'ignored', detail: 'failure_for_another_payment_intent' }, follow: [] };
    const notices = await recordFailure(tx, { teamId: p.teamId, renewal, code: failureCodeOf(p.failureCode), now, graceDays: deps.graceDays, owner, sender: deps.sender });
    return { result: { outcome: 'applied', detail: `renewal_past_due_${failureCodeOf(p.failureCode)}` }, follow: notices };
  }, TX_OPTIONS);
}

/** The processing job's branch for a renewal payment event (stripeEventJob.ts). Follow-up work rows are enqueued after the transaction that wrote them has committed. */
export async function handleRenewalPaymentEvent(deps: RenewalDeps, p: RenewalPaymentJobPayload): Promise<EventResult> {
  const { result, follow } =
    p.type === 'payment_intent.succeeded' ? await applySucceeded(deps, p) : await applyFailed(deps, p, await ownerContact(deps.shards, p.teamId));
  await enqueueAll(deps, p.teamId, follow);
  return result;
}

// ---------------------------------------------------------------- the Owner's retry

/**
 * "Retry payment" (the Owner, after fixing the card): only while the renewal is past due. There are no automatic retries. It writes the request and a work row and
 * returns; the CHARGE is the job's (AGENTS.md rule 10: the one synchronous provider call is payment-session creation). A second tap finds it already requested: 409.
 */
export async function retryRenewal(deps: { shards: Shards; enqueue?: EnqueueRow; now?: () => Date; maxWaitMs: number }, input: { teamId: string }): Promise<RenewalView> {
  const { teamId } = input;
  const team = getShard(deps.shards, teamId).primary;
  const now = (deps.now ?? (() => new Date()))();
  const work = await team.$transaction(
    async (tx) => {
      await lockTeam(tx, teamId);
      const current = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT r.id::text AS id, r.status::text AS status FROM renewals r JOIN subscriptions s ON s.team_id = r.team_id AND s.current_period_id = r.period_id
        WHERE r.team_id = ${teamId}::uuid FOR UPDATE OF r`;
      const renewal = current[0];
      if (!renewal || renewal.status === 'scheduled' || renewal.status === 'paid') throw new ApiError('not_found', { reason: 'no_overdue_renewal' });
      if (renewal.status !== 'past_due') throw new ApiError('payment_in_progress', { reason: `renewal_is_${renewal.status}` });
      await tx.$executeRaw`UPDATE renewals SET status = 'retry_requested'::renewal_status, updated_at = NOW() WHERE id = ${renewal.id}::uuid`;
      return insertWorkRow(tx, RENEWAL_KIND, { teamId, renewalId: renewal.id }, now);
    },
    { maxWait: deps.maxWaitMs },
  );
  await enqueueAll(deps, teamId, [work]); // never throws: a Valkey failure leaves the row for the sweep
  const view = await getRenewalView(deps.shards, teamId, now);
  if (!view) throw new ApiError('internal_error', { reason: 'renewal_view_missing_after_retry' });
  return view;
}
