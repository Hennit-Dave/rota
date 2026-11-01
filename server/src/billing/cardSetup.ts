// Saving a card with nothing charged (ADR 0030): Stripe Checkout in setup mode. Same shape as activation (activation.ts): the server freezes the request, makes the ONE
// bounded synchronous Stripe call (AGENTS.md rule 10) and returns Checkout's URL; it records NO outcome. Only a verified webhook, processed by the job in
// cardSaveJob.ts, decides that a card was saved (rule 7). The consent wording and every other figure are made here, as finished strings.
import { createHash, randomUUID } from 'node:crypto';
import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { ApiError } from '../http/errors.js';
import { nowOf, lockTeamAndFindPrior, OPERATION_LIFETIME_MS, type BillingDeps, type PriorRequest, type StoredAnswer } from './checkout.js';
import { consentWording } from './consent.js';
import { StripeRejectedError, StripeUncertainError } from './gateway.js';
import { monthlyCents, type PlanId } from './plans.js';
import { customerIdOf } from './savedCard.js';

/** What the app is told about a card setup: decided here, never by the app. */
export type CardSetupStatusView = 'awaiting_card' | 'confirming' | 'saved' | 'failed' | 'expired' | 'under_review';

export interface CardSetupView {
  id: string;
  status: CardSetupStatusView;
  expiresAt: string;
}

interface SetupRow {
  id: string;
  status: string;
  expires_at: Date;
  consent_wording: string;
  stripe_checkout_session_id: string | null;
}

async function loadSetup(shards: Shards, teamId: string, setupId: string): Promise<SetupRow | null> {
  // The team id is part of the lookup: another team's setup looks exactly like one that does not exist (404).
  const rows = await getShard(shards, teamId).primary.$queryRaw<SetupRow[]>`
    SELECT id::text AS id, status::text AS status, expires_at, consent_wording, stripe_checkout_session_id
    FROM card_setups WHERE id = ${setupId}::uuid AND team_id = ${teamId}::uuid`;
  return rows[0] ?? null;
}

/** A verified event for this setup's Checkout Session is recorded but not yet processed: the card is "confirming". Never cached (rule 11). */
async function hasUnprocessedSessionEvent(shards: Shards, sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false;
  const row = await identityDb(shards).stripeEvent.findFirst({ where: { checkoutSessionId: sessionId, processedAt: null }, select: { eventId: true } });
  return row !== null;
}

function statusView(row: Pick<SetupRow, 'status' | 'expires_at'>, confirming: boolean, now: Date): CardSetupStatusView {
  switch (row.status) {
    case 'completed':
      return 'saved';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'needs_review':
      return 'under_review';
    default:
      if (confirming) return 'confirming';
      return row.expires_at.getTime() <= now.getTime() ? 'expired' : 'awaiting_card';
  }
}

function viewOf(row: SetupRow, confirming: boolean, now: Date): CardSetupView {
  return { id: row.id, status: statusView(row, confirming, now), expiresAt: row.expires_at.toISOString() };
}

export async function getCardSetup(deps: BillingDeps, input: { teamId: string; setupId: string }): Promise<CardSetupView> {
  const row = await loadSetup(deps.shards, input.teamId, input.setupId);
  if (!row) throw new ApiError('not_found', { reason: 'card_setup_not_found' });
  const confirming = row.status === 'open' ? await hasUnprocessedSessionEvent(deps.shards, row.stripe_checkout_session_id) : false;
  return viewOf(row, confirming, nowOf(deps));
}

/** The buyer backed out of Stripe's page. An open setup ends now so they can try again straight away; one whose card is being recorded is not cancelled. */
export async function cancelCardSetup(deps: BillingDeps, input: { teamId: string; setupId: string }): Promise<CardSetupView> {
  const row = await loadSetup(deps.shards, input.teamId, input.setupId);
  if (!row) throw new ApiError('not_found', { reason: 'card_setup_not_found' });
  if (row.status === 'open') {
    if (await hasUnprocessedSessionEvent(deps.shards, row.stripe_checkout_session_id)) throw new ApiError('payment_in_progress', { reason: 'card_is_being_saved' });
    await getShard(deps.shards, input.teamId).primary.$executeRaw`
      UPDATE card_setups SET status = 'expired'::card_setup_status, updated_at = NOW()
      WHERE id = ${row.id}::uuid AND team_id = ${input.teamId}::uuid AND status = 'open'::card_setup_status`;
  }
  return getCardSetup(deps, input);
}

const FINGERPRINT = createHash('sha256').update('card-setup', 'utf8').digest('hex');

function rethrowOneOpenViolation(err: unknown): never {
  if (!(err instanceof ApiError) && String((err as { message?: unknown })?.message).includes('card_setups_one_open_per_team')) {
    throw new ApiError('payment_in_progress', { reason: 'unique_index' });
  }
  throw err;
}

/**
 * Starts saving a card: freezes the consent (the amount and day it names come from the team's own subscription), makes the one bounded Stripe call and returns
 * Checkout's URL. The app's Idempotency-Key makes a retry harmless exactly as for activation: the same key returns the stored answer.
 */
export async function startCardSetup(deps: BillingDeps, input: { teamId: string; actorUserId: string; idempotencyKey: string }): Promise<StoredAnswer> {
  const { teamId } = input;
  const prisma = getShard(deps.shards, teamId).primary;
  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + OPERATION_LIFETIME_MS);
  const newSetupId = randomUUID();

  let step: PriorRequest;
  try {
    step = await prisma.$transaction(
      async (tx): Promise<PriorRequest> => {
        const prior = await lockTeamAndFindPrior(tx, teamId, input.idempotencyKey, FINGERPRINT);
        if (prior.kind !== 'new') return prior;

        const subs = await tx.$queryRaw<Array<{ plan: PlanId; seats: number; billing_anchor_day: number }>>`
          SELECT plan::text AS plan, seats, billing_anchor_day FROM subscriptions WHERE team_id = ${teamId}::uuid`;
        const sub = subs[0];
        // A team that has not activated saves its card on the activation page, in the same step as paying.
        if (!sub) throw new ApiError('not_activated');

        // One open setup per team. One that nobody finished before it expired no longer blocks; any other open one is 409.
        await tx.$executeRaw`UPDATE card_setups SET status = 'expired'::card_setup_status, updated_at = NOW() WHERE team_id = ${teamId}::uuid AND status = 'open'::card_setup_status AND expires_at <= NOW()`;
        const open = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM card_setups WHERE team_id = ${teamId}::uuid AND status = 'open'::card_setup_status`;
        if (open.length > 0) throw new ApiError('payment_in_progress', { reason: 'a_card_setup_is_open' });

        const amountCents = monthlyCents({ plan: sub.plan, seats: sub.seats });
        const wording = consentWording({ kind: 'card_setup', amountCents, anchorDay: sub.billing_anchor_day });
        await tx.$executeRaw`
          INSERT INTO card_setups (id, team_id, requested_by_user_id, consent_wording, consent_amount_cents, consent_anchor_day, expires_at)
          VALUES (${newSetupId}::uuid, ${teamId}::uuid, ${input.actorUserId}::uuid, ${wording}, ${amountCents}, ${sub.billing_anchor_day}, ${expiresAt})`;
        await tx.$executeRaw`
          INSERT INTO payment_requests (team_id, user_id, idempotency_key, request_fingerprint, operation_id, response_status, response)
          VALUES (${teamId}::uuid, ${input.actorUserId}::uuid, ${input.idempotencyKey}, ${FINGERPRINT}, ${newSetupId}::uuid, 0, '{}'::jsonb)`;
        return { kind: 'proceed', operationId: newSetupId };
      },
      { maxWait: deps.maxWaitMs },
    );
  } catch (err) {
    rethrowOneOpenViolation(err);
  }

  if (step.kind === 'replay') return { status: step.status === 201 ? 200 : step.status, body: step.body, replay: true };
  if (step.kind !== 'proceed') throw new ApiError('internal_error', { reason: 'unexpected_prior_request' });
  return completeCardSetup(deps, { teamId, idempotencyKey: input.idempotencyKey, setupId: step.operationId });
}

/** From a frozen, open setup to Stripe's Checkout URL: the ONE synchronous provider call, bounded, idempotent by setup, and it records NO outcome. */
async function completeCardSetup(deps: BillingDeps, input: { teamId: string; idempotencyKey: string; setupId: string }): Promise<StoredAnswer> {
  const { teamId } = input;
  const prisma = getShard(deps.shards, teamId).primary;
  const setup = await loadSetup(deps.shards, teamId, input.setupId);
  if (!setup) throw new ApiError('internal_error', { reason: 'card_setup_vanished' });
  // A resumed attempt whose setup has since ended cannot be completed with this key: the app starts again with a new one.
  if (setup.status !== 'open') throw new ApiError('validation_failed', { details: [{ path: 'header.idempotency-key', code: 'key_expired' }] });

  let session;
  try {
    session = await deps.stripe.createSetupSession({
      setupId: setup.id,
      teamId,
      successUrl: `${deps.linkBaseUrl}/checkout/card-return?setup=${setup.id}`,
      cancelUrl: `${deps.linkBaseUrl}/checkout/card-cancel?setup=${setup.id}`,
      expiresAt: setup.expires_at,
      saveCard: { consentText: setup.consent_wording, customerId: await customerIdOf(prisma, teamId) },
    });
  } catch (err) {
    if (err instanceof StripeRejectedError) {
      const failure = { error: { code: 'service_unavailable', message: new ApiError('service_unavailable').message } };
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE card_setups SET status = 'failed'::card_setup_status, updated_at = NOW() WHERE id = ${setup.id}::uuid AND team_id = ${teamId}::uuid AND status = 'open'::card_setup_status`;
          await tx.$executeRaw`UPDATE payment_requests SET response_status = 503, response = ${JSON.stringify(failure)}::jsonb WHERE team_id = ${teamId}::uuid AND idempotency_key = ${input.idempotencyKey} AND response_status = 0`;
        },
        { maxWait: deps.maxWaitMs },
      );
      throw new ApiError('service_unavailable', { reason: `stripe_${err.reason}` });
    }
    if (err instanceof StripeUncertainError) throw new ApiError('service_unavailable', { reason: `stripe_uncertain_${err.reason}` });
    throw err;
  }

  const body = { status: 'card_setup_required', setup: viewOf(setup, false, nowOf(deps)), checkoutUrl: session.url };
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE card_setups SET stripe_checkout_session_id = ${session.id}, updated_at = NOW()
        WHERE id = ${setup.id}::uuid AND team_id = ${teamId}::uuid AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ${session.id})`;
      await tx.$executeRaw`
        UPDATE payment_requests SET response_status = 201, response = ${JSON.stringify(body)}::jsonb
        WHERE team_id = ${teamId}::uuid AND idempotency_key = ${input.idempotencyKey} AND response_status = 0`;
    },
    { maxWait: deps.maxWaitMs },
  );
  return { status: 201, body, replay: false };
}
