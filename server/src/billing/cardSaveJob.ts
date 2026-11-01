// Saving a card, in the Stripe event job (ADR 0030; AGENTS.md rules 7, 9, 10). Two ways a card arrives, both decided here and never by the app or the request:
//   1. a setup-mode Checkout (nothing charged): `handleCardSetupEvent` matches the event to the card_setups row we froze, reads the SetupIntent from Stripe, and records the card;
//   2. an activation payment that asked Checkout to save the card: `saveActivationCard` runs AFTER the payment was applied, so a card that cannot be saved never undoes a payment.
// A valid signature proves Stripe sent the event, not that it is the card we asked for, so every field is matched before anything is recorded. The Stripe READ happens
// outside the database transaction (never hold a transaction open across a network call); only the recording is transactional.
import { getShard, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { StripeRejectedError, type SavedCardFacts, type StripeGateway } from './gateway.js';
import { anchorDayOf } from './periods.js';
import { insertActiveCard } from './savedCard.js';
import type { CardSetupJobPayload, StripeEventJobPayload } from './stripeEvent.js';

export interface CardJobDeps {
  shards: Shards;
  stripe: StripeGateway;
}

export interface JobResult {
  outcome: 'applied' | 'duplicate' | 'review' | 'ignored';
  /** For the log only. Never shown to the app. */
  detail: string;
}

const TX_OPTIONS = { maxWait: 5000, timeout: 15_000 } as const;

/** What an intent must show before its card is recorded. Returns the first problem, or null. */
function problemWith(
  facts: SavedCardFacts,
  expected: { teamId: string; metadataKey: 'operation_id' | 'card_setup_id'; metadataValue: string; sessionCustomerId: string | null },
): string | null {
  if (facts.livemode) return 'live_mode_intent'; // test mode only
  if (facts.status !== 'succeeded') return `intent_${facts.status}`;
  if (facts.usage !== 'off_session') return 'not_saved_for_off_session_use';
  if (facts.methodType !== 'card' || !facts.card || !facts.paymentMethodId) return 'not_a_card';
  if (!facts.customerId) return 'no_customer';
  if (expected.sessionCustomerId && facts.customerId !== expected.sessionCustomerId) return 'customer_mismatch';
  if (facts.metadata.team_id !== expected.teamId || facts.metadata[expected.metadataKey] !== expected.metadataValue) return 'metadata_mismatch';
  return null;
}

// ---- 1. Activation: the card saved by the payment ----

/**
 * After an activation payment was applied (or replayed), saves the card that payment was made with. Never throws for a card problem: the payment stands, the team
 * simply has no saved card and follows the failed-renewal path at renewal (ADR 0030). A Stripe outcome we cannot know (timeout, 5xx) DOES throw, so the job retries.
 */
export async function saveActivationCard(deps: CardJobDeps, p: StripeEventJobPayload, consentedAt: Date): Promise<{ saved: boolean; detail: string }> {
  if (!p.paymentIntentId) return { saved: false, detail: 'card_not_saved:payment_intent_missing' };
  const team = getShard(deps.shards, p.teamId).primary;
  const ops = await team.$queryRaw<Array<{ id: string; quote_cents: number; activation_date: string | null; consent_wording: string | null }>>`
    SELECT id::text AS id, quote_cents, activation_date::text AS activation_date, consent_wording FROM payment_operations
    WHERE id = ${p.operationId}::uuid AND team_id = ${p.teamId}::uuid AND kind = 'activation'::payment_operation_kind
      AND status = 'completed'::payment_operation_status AND stripe_payment_intent_id = ${p.paymentIntentId}`;
  const op = ops[0];
  if (!op) return { saved: false, detail: 'card_not_saved:no_completed_activation_for_this_payment' };
  // An activation made before P6a never asked Checkout to save a card.
  if (op.consent_wording === null || op.activation_date === null) return { saved: false, detail: 'card_not_requested' };

  const already = await team.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM team_payment_methods WHERE source_id = ${op.id}::uuid AND team_id = ${p.teamId}::uuid`;
  if (already.length > 0) return { saved: false, detail: 'card_already_saved' };

  let facts: SavedCardFacts;
  try {
    facts = await deps.stripe.retrievePaymentIntentCard(p.paymentIntentId);
  } catch (err) {
    if (err instanceof StripeRejectedError) return { saved: false, detail: `card_not_saved:stripe_rejected_${err.reason}` };
    throw err; // unknown outcome: the job retries; the payment is already applied and a replay finds it so
  }
  const problem = problemWith(facts, { teamId: p.teamId, metadataKey: 'operation_id', metadataValue: op.id, sessionCustomerId: p.customerId ?? null });
  if (problem) return { saved: false, detail: `card_not_saved:${problem}` };

  const result = await team.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM teams WHERE id = ${p.teamId}::uuid FOR UPDATE`;
    return insertActiveCard(tx, {
      teamId: p.teamId,
      customerId: facts.customerId!,
      paymentMethodId: facts.paymentMethodId!,
      card: facts.card!,
      source: 'activation',
      sourceId: op.id,
      consentWording: op.consent_wording!,
      consentAmountCents: op.quote_cents,
      consentAnchorDay: anchorDayOf(op.activation_date!),
      consentedAt,
    });
  }, TX_OPTIONS);
  return result === 'inserted' || result === 'duplicate' ? { saved: result === 'inserted', detail: `card_${result}` } : { saved: false, detail: `card_not_saved:${result}` };
}

// ---- 2. Setup mode: a card saved with nothing charged ----

interface SetupRow {
  id: string;
  status: string;
  consent_wording: string;
  consent_amount_cents: number;
  consent_anchor_day: number;
  stripe_checkout_session_id: string | null;
  stripe_setup_intent_id: string | null;
}

/** Marks the setup as needing a human: a card was saved on Stripe's side that we could not record. Never raises, never records a card. */
async function flagSetup(team: Pick<PrismaClient, '$executeRaw'>, p: CardSetupJobPayload, reason: string): Promise<JobResult> {
  await team.$executeRaw`
    UPDATE card_setups SET status = 'needs_review'::card_setup_status, review_reason = ${`${reason} (session ${p.sessionId})`}, updated_at = NOW()
    WHERE id = ${p.cardSetupId}::uuid AND team_id = ${p.teamId}::uuid AND status IN ('open'::card_setup_status, 'expired'::card_setup_status, 'failed'::card_setup_status)`;
  return { outcome: 'review', detail: reason };
}

async function loadSetup(team: Pick<PrismaClient, '$queryRaw'>, p: CardSetupJobPayload, lock: boolean): Promise<SetupRow | undefined> {
  const rows = lock
    ? await team.$queryRaw<SetupRow[]>`
        SELECT id::text AS id, status::text AS status, consent_wording, consent_amount_cents, consent_anchor_day, stripe_checkout_session_id, stripe_setup_intent_id
        FROM card_setups WHERE id = ${p.cardSetupId}::uuid AND team_id = ${p.teamId}::uuid FOR UPDATE`
    : await team.$queryRaw<SetupRow[]>`
        SELECT id::text AS id, status::text AS status, consent_wording, consent_amount_cents, consent_anchor_day, stripe_checkout_session_id, stripe_setup_intent_id
        FROM card_setups WHERE id = ${p.cardSetupId}::uuid AND team_id = ${p.teamId}::uuid`;
  return rows[0];
}

/** A setup whose Checkout Session ended without a card: only an OPEN setup can end. */
async function closeSetup(team: PrismaClient, p: CardSetupJobPayload): Promise<JobResult> {
  const closed = await team.$executeRaw`
    UPDATE card_setups SET status = 'expired'::card_setup_status, updated_at = NOW()
    WHERE id = ${p.cardSetupId}::uuid AND team_id = ${p.teamId}::uuid AND status = 'open'::card_setup_status
      AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ${p.sessionId})`;
  return closed > 0 ? { outcome: 'applied', detail: 'card_setup_expired' } : { outcome: 'ignored', detail: 'card_setup_not_open' };
}

export async function handleCardSetupEvent(deps: CardJobDeps, p: CardSetupJobPayload, consentedAt: Date): Promise<JobResult> {
  const team = getShard(deps.shards, p.teamId).primary;
  if (p.type === 'checkout.session.expired') return closeSetup(team, p);

  const setup = await loadSetup(team, p, false);
  if (!setup) return { outcome: 'review', detail: 'card_setup_not_found' };
  // Already recorded (a replay, or a second event for the same SetupIntent): nothing to do.
  if (setup.status === 'completed') {
    return setup.stripe_setup_intent_id === p.setupIntentId ? { outcome: 'duplicate', detail: 'card_already_saved' } : { outcome: 'review', detail: 'setup_completed_with_a_different_intent' };
  }
  if (setup.status === 'needs_review') return { outcome: 'review', detail: 'card_setup_already_in_review' };
  // Finished by the buyer after we closed it (cancelled, expired): a card exists at Stripe that we did not ask to keep. Recorded, not applied, a human looks.
  if (setup.status !== 'open') return flagSetup(team, p, `completed_after_${setup.status}`);

  if (p.mode !== 'setup') return flagSetup(team, p, 'not_a_setup_session');
  if (setup.stripe_checkout_session_id !== null && setup.stripe_checkout_session_id !== p.sessionId) return flagSetup(team, p, 'session_mismatch');
  if (!p.setupIntentId) return flagSetup(team, p, 'setup_intent_missing');
  if (!p.customerId) return flagSetup(team, p, 'customer_missing');

  // The Stripe READ is outside the transaction. An unknown outcome throws (the job retries); a refusal goes to review.
  let facts: SavedCardFacts;
  try {
    facts = await deps.stripe.retrieveSetupIntentCard(p.setupIntentId);
  } catch (err) {
    if (err instanceof StripeRejectedError) return flagSetup(team, p, `stripe_rejected_${err.reason}`);
    throw err;
  }
  const problem = problemWith(facts, { teamId: p.teamId, metadataKey: 'card_setup_id', metadataValue: setup.id, sessionCustomerId: p.customerId });
  if (problem) return flagSetup(team, p, problem);

  return team.$transaction(
    async (tx): Promise<JobResult> => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id = ${p.teamId}::uuid FOR UPDATE`;
      // Re-read under the lock: the buyer may have cancelled while we were talking to Stripe.
      const locked = await loadSetup(tx, p, true);
      if (!locked || locked.status !== 'open') return { outcome: 'ignored', detail: `card_setup_${locked?.status ?? 'missing'}_at_apply` };

      const result = await insertActiveCard(tx, {
        teamId: p.teamId,
        customerId: facts.customerId!,
        paymentMethodId: facts.paymentMethodId!,
        card: facts.card!,
        source: 'card_setup',
        sourceId: locked.id,
        consentWording: locked.consent_wording,
        consentAmountCents: locked.consent_amount_cents,
        consentAnchorDay: locked.consent_anchor_day,
        consentedAt,
      });
      if (result === 'customer_mismatch' || result === 'belongs_to_another_team') return flagSetup(tx, p, result);
      // 'duplicate' here means the card is already recorded (a replay that lost the setup row's update): finish the setup, record nothing new.
      await tx.$executeRaw`
        UPDATE card_setups SET status = 'completed'::card_setup_status, stripe_setup_intent_id = ${p.setupIntentId}, completed_at = NOW(), updated_at = NOW()
        WHERE id = ${locked.id}::uuid AND team_id = ${p.teamId}::uuid AND status = 'open'::card_setup_status`;
      return { outcome: result === 'inserted' ? 'applied' : 'duplicate', detail: result === 'inserted' ? 'card_saved' : 'card_already_saved' };
    },
    TX_OPTIONS,
  );
}
