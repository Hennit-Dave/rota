// What we accept from Stripe, and what the processing job is handed. Only the events a Checkout payment needs (ADR 0027); `payment_intent.*` is
// deliberately not subscribed, so one payment does not arrive as two overlapping event families.
import { z } from 'zod';
import { CANONICAL_UUID } from '../db/shard.js';

export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/** The fields every Stripe event has. Read first, so an event type we do not handle is acknowledged without demanding a shape from it. */
export const eventEnvelope = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  livemode: z.boolean(),
  created: z.number().int(),
});

const metadata = z.record(z.string(), z.string()).nullable().optional();

/** A Checkout Session event, after its signature was verified (rule 7). Unknown fields are dropped. */
export const checkoutSessionEvent = eventEnvelope.extend({
  type: z.enum(HANDLED_EVENT_TYPES),
  data: z.object({
    object: z.object({
      id: z.string().min(1).max(255),
      mode: z.string().max(32).nullable().optional(),
      payment_intent: z.string().min(1).max(255).nullable().optional(),
      setup_intent: z.string().min(1).max(255).nullable().optional(),
      /** The Stripe Customer: set when Checkout saved a card (it made one, or used the one we passed). */
      customer: z.string().min(1).max(255).nullable().optional(),
      payment_status: z.string().max(64).nullable().optional(),
      amount_total: z.number().int().nullable().optional(),
      currency: z.string().max(16).nullable().optional(),
      metadata,
    }),
  }),
});

/**
 * The work row's payload for the processing job: exactly what it must match against the frozen operation (money.md), copied from the verified event.
 * It sits on the work row, not on `stripe_events`, so P3 needs no schema change. No secret is in it.
 */
export const stripeEventJobPayload = z.object({
  eventId: z.string().min(1).max(255),
  type: z.enum(HANDLED_EVENT_TYPES),
  sessionId: z.string().min(1).max(255),
  paymentIntentId: z.string().min(1).max(255).nullable(),
  paymentStatus: z.string().max(64).nullable(),
  amountTotal: z.number().int().nullable(),
  currency: z.string().max(16).nullable(),
  teamId: z.string().regex(CANONICAL_UUID),
  operationId: z.string().regex(CANONICAL_UUID),
  /** The Customer Checkout saved the card on (ADR 0030). Optional so a work row recorded before P6a still parses. */
  customerId: z.string().min(1).max(255).nullable().optional(),
});
export type StripeEventJobPayload = z.infer<typeof stripeEventJobPayload>;

/**
 * The job payload for a setup-mode Checkout Session (a card saved, nothing charged; ADR 0030). `purpose` tells the job which payload it holds; the payload of a
 * payment event has none, so every row recorded before P6a is still read as a payment.
 */
export const cardSetupJobPayload = z.object({
  purpose: z.literal('card_setup'),
  eventId: z.string().min(1).max(255),
  type: z.enum(HANDLED_EVENT_TYPES),
  sessionId: z.string().min(1).max(255),
  mode: z.string().max(32).nullable(),
  setupIntentId: z.string().min(1).max(255).nullable(),
  customerId: z.string().min(1).max(255).nullable(),
  teamId: z.string().regex(CANONICAL_UUID),
  cardSetupId: z.string().regex(CANONICAL_UUID),
});
export type CardSetupJobPayload = z.infer<typeof cardSetupJobPayload>;

/** The team and card-setup ids Stripe echoes back from our metadata on a setup-mode session, or null when the event is not one of ours (or malformed). */
export function ourSetupMetadata(meta: Record<string, string> | null | undefined): { teamId: string; cardSetupId: string } | null {
  const teamId = meta?.team_id;
  const cardSetupId = meta?.card_setup_id;
  if (typeof teamId !== 'string' || typeof cardSetupId !== 'string') return null;
  if (!CANONICAL_UUID.test(teamId) || !CANONICAL_UUID.test(cardSetupId)) return null;
  return { teamId, cardSetupId };
}

/** The team and operation ids Stripe echoes back from our metadata, or null when the event is not one of ours (or malformed). */
export function ourMetadata(meta: Record<string, string> | null | undefined): { teamId: string; operationId: string } | null {
  const teamId = meta?.team_id;
  const operationId = meta?.operation_id;
  if (typeof teamId !== 'string' || typeof operationId !== 'string') return null;
  if (!CANONICAL_UUID.test(teamId) || !CANONICAL_UUID.test(operationId)) return null;
  return { teamId, operationId };
}
