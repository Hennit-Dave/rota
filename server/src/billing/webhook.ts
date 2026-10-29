// The Stripe webhook route (AGENTS.md rules 7 and 9; the webhook-handler skill). In this order and no other:
//   raw body -> signature verified BEFORE anything is parsed -> Zod on the event -> durably recorded on shard A (deduplicated by event id)
//   -> job enqueued -> acknowledged. No business processing happens here: the job decides what the event means (stripeEventJob.ts).
// Before the signature is verified nothing about the body is read, parsed or logged.
import express, { type RequestHandler } from 'express';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import type { ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import type { StripeGateway } from './gateway.js';
import { checkoutSessionEvent, eventEnvelope, HANDLED_EVENT_TYPES, ourMetadata, type StripeEventJobPayload } from './stripeEvent.js';

export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe';
/** A Checkout event is a few kilobytes. 256 kb is a request-size bound, not a product number. */
const WEBHOOK_BODY_LIMIT = '256kb';
/** available_at = run_at + 2 minutes on normal creation (jobs.md). */
const SWEEP_GRACE_MS = 2 * 60 * 1000;

export interface WebhookDeps {
  shards: Shards;
  stripe: StripeGateway;
  logger: Logger;
  /** Enqueues an ALREADY COMMITTED work row. Never throws (see `enqueueCommittedRow`). */
  enqueue: (prisma: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => Promise<void>;
  now?: () => Date;
}

class DuplicateEvent extends Error {}

/**
 * The handler pair for `POST /webhooks/stripe`: `express.raw` on THIS route only, then the handler. app.ts registers it before any router that parses JSON,
 * and nothing in the app uses a global `express.json()` (AGENTS.md rule 7).
 */
export function createStripeWebhook(deps: WebhookDeps): RequestHandler[] {
  const { shards, logger } = deps;
  const prisma = identityDb(shards); // shard A holds the inbox

  const handler: RequestHandler = async (req, res) => {
    const requestId = String(res.locals.requestId ?? '');
    const signature = req.get('stripe-signature');
    // Not JSON, or no signature: nothing to verify. Rejected without reading the body.
    if (!signature || !Buffer.isBuffer(req.body)) throw new ApiError('validation_failed', { reason: 'webhook_unverifiable' });

    let verified: unknown;
    try {
      verified = deps.stripe.constructEvent(req.body, signature);
    } catch {
      throw new ApiError('validation_failed', { reason: 'webhook_signature_invalid' });
    }

    const envelope = eventEnvelope.safeParse(verified);
    if (!envelope.success) throw new ApiError('validation_failed', { reason: 'webhook_event_malformed' });
    const { id: eventId, type, livemode, created } = envelope.data;

    // This integration is test mode only. A live event is refused loudly and never recorded.
    if (livemode) {
      logger.error('stripe_live_event_refused', { requestId, eventId, outcome: 'refused', reason: 'live_mode_event' });
      throw new ApiError('validation_failed', { reason: 'live_mode_event_refused' });
    }

    // Events we do not act on (the CLI forwards everything unless told otherwise): acknowledged, not recorded.
    if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(type)) {
      logger.info('stripe_event_ignored', { requestId, eventId, outcome: 'ignored_type' });
      res.status(200).json({ received: true });
      return;
    }

    const parsed = checkoutSessionEvent.safeParse(verified);
    if (!parsed.success) throw new ApiError('validation_failed', { reason: 'webhook_event_malformed' });
    const session = parsed.data.data.object;
    const ours = ourMetadata(session.metadata);
    if (!ours) {
      // A Checkout Session this app did not make (the sandbox account may be used for other things).
      logger.info('stripe_event_ignored', { requestId, eventId, outcome: 'ignored_not_ours' });
      res.status(200).json({ received: true });
      return;
    }

    const jobPayload: StripeEventJobPayload = {
      eventId,
      type: parsed.data.type,
      sessionId: session.id,
      paymentIntentId: session.payment_intent ?? null,
      paymentStatus: session.payment_status ?? null,
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
      teamId: ours.teamId,
      operationId: ours.operationId,
    };
    const now = (deps.now ?? (() => new Date()))();

    // Record first (rule 9): the event row and its work row commit together. A repeated event id inserts nothing and rolls the work row back.
    let work: WorkRow | null = null;
    try {
      work = await prisma.$transaction(async (tx) => {
        const row = await tx.workRow.create({
          data: {
            kind: 'stripe_event',
            payload: jobPayload,
            originRequestId: requestId || null,
            runAt: now,
            availableAt: new Date(now.getTime() + SWEEP_GRACE_MS),
            status: 'pending',
            generation: 1,
            executionAttempts: 0,
          },
        });
        const inserted = await tx.stripeEvent.createMany({
          data: [
            {
              eventId,
              eventType: type,
              livemode: false,
              stripeCreatedAt: new Date(created * 1000),
              checkoutSessionId: session.id,
              paymentIntentId: jobPayload.paymentIntentId,
              teamId: ours.teamId,
              operationId: ours.operationId,
              workRowId: row.id,
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) throw new DuplicateEvent();
        return row;
      });
    } catch (err) {
      if (!(err instanceof DuplicateEvent)) throw err;
    }

    if (work) {
      await deps.enqueue(prisma, work, 'A');
      logger.info('stripe_event_recorded', { requestId, eventId, operationId: ours.operationId, teamId: ours.teamId, outcome: 'recorded' });
    } else {
      // Stripe sent this event id before. Processed: nothing to do. Recorded but not processed: put its job back (jobs.md, Stripe redelivery).
      const existing = await prisma.stripeEvent.findUnique({ where: { eventId }, include: { workRow: true } });
      if (existing?.processedAt) {
        logger.info('stripe_event_duplicate', { requestId, eventId, outcome: 'duplicate_processed' });
      } else if (existing?.workRow && existing.workRow.status === 'pending') {
        await deps.enqueue(prisma, existing.workRow, 'A');
        logger.info('stripe_event_duplicate', { requestId, eventId, outcome: 're_enqueued' });
      } else {
        logger.warn('stripe_event_duplicate', { requestId, eventId, outcome: 'unprocessed_without_pending_work', reason: existing?.workRow?.status ?? 'no_work_row' });
      }
    }

    res.status(200).json({ received: true });
  };

  return [express.raw({ type: 'application/json', limit: WEBHOOK_BODY_LIMIT }), handler];
}
