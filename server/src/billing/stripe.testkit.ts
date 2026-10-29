// Test helpers for the Stripe integration (not imported by the app). Nothing here reaches Stripe: the "Stripe" is a fake that behaves like the documented
// one where it matters (the SAME idempotency key returns the SAME session), and webhook events are signed with Stripe's own test-header generator.
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { Shards } from '../db/clients.js';
import type { ShardId } from '../db/shard.js';
import { createWorkProcessor } from '../jobs/worker.js';
import {
  checkoutIdempotencyKey,
  createStripeGateway,
  StripeRejectedError,
  StripeUncertainError,
  type CheckoutRequest,
  type CheckoutSession,
  type StripeGateway,
} from './gateway.js';
import { createStripeEventHandler } from './stripeEventJob.js';

/** A made-up signing secret for tests only. It signs nothing real. */
export const TEST_WEBHOOK_SECRET = 'whsec_test_only_not_a_real_secret_0123456789';

export type FakeStep = 'ok' | 'rejected' | 'uncertain_before_create' | 'uncertain_after_create';

export class FakeStripe implements StripeGateway {
  calls: Array<{ key: string; request: CheckoutRequest }> = [];
  script: FakeStep[] = [];
  private sessions = new Map<string, CheckoutSession>();
  private real = createStripeGateway({ secretKey: 'sk_test_unused_no_network_in_tests', webhookSecret: TEST_WEBHOOK_SECRET, timeoutMs: 1000 });

  /** Distinct sessions that exist on the fake Stripe: one per idempotency key. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  async createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession> {
    const key = checkoutIdempotencyKey(request.operationId);
    this.calls.push({ key, request });
    const step = this.script.shift() ?? 'ok';
    if (step === 'rejected') throw new StripeRejectedError('StripeInvalidRequestError');
    if (step === 'uncertain_before_create') throw new StripeUncertainError('StripeConnectionError');
    let session = this.sessions.get(key);
    if (!session) {
      const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
      session = { id, url: `https://checkout.stripe.test/c/pay/${id}` };
      this.sessions.set(key, session);
    }
    if (step === 'uncertain_after_create') throw new StripeUncertainError('StripeConnectionError');
    return session;
  }

  constructEvent(rawBody: Buffer, signatureHeader: string): unknown {
    return this.real.constructEvent(rawBody, signatureHeader);
  }
}

export interface EventOptions {
  id?: string;
  type?: string;
  livemode?: boolean;
  sessionId: string;
  paymentIntent?: string | null;
  paymentStatus?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
  teamId?: string | null;
  operationId?: string | null;
}

/** The JSON body of a Checkout Session event, as Stripe sends it (only the fields that matter, plus noise to prove it is ignored). */
export function checkoutEventBody(o: EventOptions): string {
  return JSON.stringify({
    id: o.id ?? `evt_test_${randomUUID().replaceAll('-', '')}`,
    object: 'event',
    api_version: '2026-09-30.endive',
    created: Math.floor(Date.now() / 1000),
    livemode: o.livemode ?? false,
    type: o.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: o.sessionId,
        object: 'checkout.session',
        mode: 'payment',
        status: 'complete',
        payment_status: o.paymentStatus === undefined ? 'paid' : o.paymentStatus,
        payment_intent: o.paymentIntent === undefined ? `pi_test_${randomUUID().replaceAll('-', '')}` : o.paymentIntent,
        amount_total: o.amountTotal === undefined ? null : o.amountTotal,
        currency: o.currency === undefined ? 'usd' : o.currency,
        customer_details: { email: 'someone@example.com' },
        metadata: o.teamId && o.operationId ? { team_id: o.teamId, operation_id: o.operationId } : {},
      },
    },
  });
}

const signer = new Stripe('sk_test_unused_no_network_in_tests');
export function signedHeaders(payload: string, secret = TEST_WEBHOOK_SECRET): Record<string, string> {
  return { 'content-type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret }) };
}

export async function sendWebhook(base: string, payload: string, headers: Record<string, string> = signedHeaders(payload)) {
  const res = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers, body: payload });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text };
}

/** Runs the REAL job processor (claim, handler, completion) for each recorded work row, as the worker would. */
export async function runStripeJobs(shards: Shards, rows: Array<{ rowId: string; shard: ShardId }>): Promise<void> {
  const processor = createWorkProcessor(shards, { stripe_event: createStripeEventHandler({ shards }) });
  for (const row of rows) {
    await processor({ id: `job-${row.rowId}-1`, data: { rowId: row.rowId, generation: 1, shard: row.shard } } as any, undefined);
  }
}
