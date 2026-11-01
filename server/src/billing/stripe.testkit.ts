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
  renewalIdempotencyKey,
  StripeCardDeclinedError,
  StripeRejectedError,
  StripeUncertainError,
  setupIdempotencyKey,
  type CheckoutRequest,
  type CheckoutSession,
  type RenewalCharge,
  type RenewalChargeRequest,
  type SavedCardFacts,
  type SetupRequest,
  type StripeGateway,
} from './gateway.js';
import { createStripeEventHandler } from './stripeEventJob.js';

/** A made-up signing secret for tests only. It signs nothing real. */
export const TEST_WEBHOOK_SECRET = 'whsec_test_only_not_a_real_secret_0123456789';

export type FakeStep = 'ok' | 'rejected' | 'uncertain_before_create' | 'uncertain_after_create';
/** What a renewal charge does on the fake Stripe: `declined` makes a PaymentIntent and refuses (the webhook will say so), `declined_no_intent` refuses without one. */
export type FakeChargeStep = FakeStep | 'declined' | 'declined_no_intent';

/** What a SUCCEEDED, off-session SetupIntent or PaymentIntent with a Visa 4242 looks like, with any field overridden. */
export function savedCardFacts(overrides: Partial<SavedCardFacts> = {}): SavedCardFacts {
  return {
    status: 'succeeded',
    livemode: false,
    customerId: 'cus_test_default',
    paymentMethodId: `pm_test_${randomUUID().replaceAll('-', '')}`,
    methodType: 'card',
    card: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2031 },
    metadata: {},
    usage: 'off_session',
    ...overrides,
  };
}

export class FakeStripe implements StripeGateway {
  calls: Array<{ key: string; request: CheckoutRequest }> = [];
  script: FakeStep[] = [];
  setupCalls: Array<{ key: string; request: SetupRequest }> = [];
  setupScript: FakeStep[] = [];
  /** The intents the fake Stripe "holds", by id: a test puts what Stripe would answer for the event it is about to send. */
  intents = new Map<string, SavedCardFacts>();
  retrieveScript: Array<'ok' | 'uncertain' | 'rejected'> = [];
  retrieved: string[] = [];
  /** Renewal charges (ADR 0031): each call, in order, with the idempotency key it used. The SAME key returns the SAME PaymentIntent, like the real thing. */
  renewalCalls: Array<{ key: string; request: RenewalChargeRequest }> = [];
  renewalScript: FakeChargeStep[] = [];
  renewalIntents = new Map<string, string>();
  private sessions = new Map<string, CheckoutSession>();
  private setupSessions = new Map<string, CheckoutSession>();
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

  async createSetupSession(request: SetupRequest): Promise<CheckoutSession> {
    const key = setupIdempotencyKey(request.setupId);
    this.setupCalls.push({ key, request });
    const step = this.setupScript.shift() ?? 'ok';
    if (step === 'rejected') throw new StripeRejectedError('StripeInvalidRequestError');
    if (step === 'uncertain_before_create') throw new StripeUncertainError('StripeConnectionError');
    let session = this.setupSessions.get(key);
    if (!session) {
      const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
      session = { id, url: `https://checkout.stripe.test/c/setup/${id}` };
      this.setupSessions.set(key, session);
    }
    if (step === 'uncertain_after_create') throw new StripeUncertainError('StripeConnectionError');
    return session;
  }

  async createRenewalPayment(request: RenewalChargeRequest): Promise<RenewalCharge> {
    const key = renewalIdempotencyKey(request.renewalId, request.attempt);
    this.renewalCalls.push({ key, request });
    const step = this.renewalScript.shift() ?? 'ok';
    if (step === 'rejected') throw new StripeRejectedError('StripeInvalidRequestError');
    if (step === 'uncertain_before_create') throw new StripeUncertainError('StripeConnectionError');
    if (step === 'declined_no_intent') throw new StripeCardDeclinedError(null, 'card_declined');
    let id = this.renewalIntents.get(key);
    if (!id) {
      id = `pi_test_${randomUUID().replaceAll('-', '')}`;
      this.renewalIntents.set(key, id);
    }
    if (step === 'declined') throw new StripeCardDeclinedError(id, 'card_declined');
    if (step === 'uncertain_after_create') throw new StripeUncertainError('StripeConnectionError');
    return { paymentIntentId: id, status: 'succeeded' };
  }

  private read(id: string): SavedCardFacts {
    this.retrieved.push(id);
    const step = this.retrieveScript.shift() ?? 'ok';
    if (step === 'uncertain') throw new StripeUncertainError('StripeConnectionError');
    const facts = this.intents.get(id);
    if (step === 'rejected' || !facts) throw new StripeRejectedError('StripeInvalidRequestError');
    return facts;
  }

  async retrieveSetupIntentCard(id: string): Promise<SavedCardFacts> {
    return this.read(id);
  }

  async retrievePaymentIntentCard(id: string): Promise<SavedCardFacts> {
    return this.read(id);
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
  /** Setup mode (ADR 0030): a card saved, nothing charged. */
  mode?: 'payment' | 'setup';
  setupIntent?: string | null;
  customer?: string | null;
  cardSetupId?: string | null;
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
        mode: o.mode ?? 'payment',
        status: 'complete',
        payment_status: o.paymentStatus === undefined ? (o.mode === 'setup' ? 'no_payment_required' : 'paid') : o.paymentStatus,
        payment_intent: o.paymentIntent === undefined ? (o.mode === 'setup' ? null : `pi_test_${randomUUID().replaceAll('-', '')}`) : o.paymentIntent,
        setup_intent: o.setupIntent ?? null,
        customer: o.customer ?? null,
        amount_total: o.amountTotal === undefined ? null : o.amountTotal,
        currency: o.currency === undefined ? 'usd' : o.currency,
        customer_details: { email: 'someone@example.com' },
        metadata: o.teamId && o.cardSetupId ? { team_id: o.teamId, card_setup_id: o.cardSetupId } : o.teamId && o.operationId ? { team_id: o.teamId, operation_id: o.operationId } : {},
      },
    },
  });
}

export interface IntentEventOptions {
  id?: string;
  type?: 'payment_intent.succeeded' | 'payment_intent.payment_failed';
  livemode?: boolean;
  paymentIntentId: string;
  teamId?: string | null;
  renewalId?: string | null;
  attempt?: number | null;
  amount?: number;
  currency?: string;
  status?: string;
  /** `last_payment_error.code`, for a failed payment. */
  errorCode?: string | null;
  /** A PaymentIntent that Checkout made (an activation or a paid change) has an operation id and no renewal id. */
  operationId?: string | null;
}

/** The JSON body of a PaymentIntent event, as Stripe sends it (only the fields that matter, plus noise to prove it is ignored). */
export function intentEventBody(o: IntentEventOptions): string {
  const type = o.type ?? 'payment_intent.succeeded';
  const metadata: Record<string, string> = {};
  if (o.teamId) metadata.team_id = o.teamId;
  if (o.renewalId) metadata.renewal_id = o.renewalId;
  if (o.attempt !== undefined && o.attempt !== null) metadata.attempt = String(o.attempt);
  if (o.operationId) metadata.operation_id = o.operationId;
  return JSON.stringify({
    id: o.id ?? `evt_test_${randomUUID().replaceAll('-', '')}`,
    object: 'event',
    api_version: '2026-09-30.endive',
    created: Math.floor(Date.now() / 1000),
    livemode: o.livemode ?? false,
    type,
    data: {
      object: {
        id: o.paymentIntentId,
        object: 'payment_intent',
        status: o.status ?? (type === 'payment_intent.succeeded' ? 'succeeded' : 'requires_payment_method'),
        amount: o.amount ?? 5000,
        amount_received: type === 'payment_intent.succeeded' ? (o.amount ?? 5000) : 0,
        currency: o.currency ?? 'usd',
        customer: 'cus_test_default',
        payment_method: 'pm_test_default',
        metadata,
        last_payment_error: type === 'payment_intent.payment_failed' ? { code: o.errorCode === undefined ? 'card_declined' : o.errorCode, decline_code: 'generic_decline', type: 'card_error' } : null,
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
export async function runStripeJobs(shards: Shards, rows: Array<{ rowId: string; shard: ShardId }>, stripe: StripeGateway = new FakeStripe()): Promise<void> {
  const processor = createWorkProcessor(shards, { stripe_event: createStripeEventHandler({ shards, stripe }) });
  for (const row of rows) {
    await processor({ id: `job-${row.rowId}-1`, data: { rowId: row.rowId, generation: 1, shard: row.shard } } as any, undefined);
  }
}
