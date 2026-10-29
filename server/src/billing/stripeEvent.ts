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
      payment_intent: z.string().min(1).max(255).nullable().optional(),
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
});
export type StripeEventJobPayload = z.infer<typeof stripeEventJobPayload>;

/** The team and operation ids Stripe echoes back from our metadata, or null when the event is not one of ours (or malformed). */
export function ourMetadata(meta: Record<string, string> | null | undefined): { teamId: string; operationId: string } | null {
  const teamId = meta?.team_id;
  const operationId = meta?.operation_id;
  if (typeof teamId !== 'string' || typeof operationId !== 'string') return null;
  if (!CANONICAL_UUID.test(teamId) || !CANONICAL_UUID.test(operationId)) return null;
  return { teamId, operationId };
}
