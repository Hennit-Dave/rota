// The one door to Stripe (AGENTS.md rules 6, 7, 10). Everything Stripe-shaped stays in this file so the rest of the billing code, and its tests,
// deal in plain objects. Two jobs: create a Checkout Session (the one synchronous provider call, bounded and idempotent) and verify a webhook's
// signature against the RAW body. Stripe only collects an amount WE calculated; this file never calculates one.
import Stripe from 'stripe';
import type { StripeConfig } from './stripeConfig.js';

export interface CheckoutRequest {
  operationId: string;
  teamId: string;
  /** Integer cents, calculated by our own engine and frozen on the payment operation. */
  amountCents: number;
  /** What the buyer sees on Stripe's page, for example "Rota Team plan, 9 seats". */
  productName: string;
  successUrl: string;
  cancelUrl: string;
  /** Stored on the operation, so a retry sends exactly the same request (Stripe refuses a reused key with different parameters). */
  expiresAt: Date;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Stripe refused this request outright (a 4xx that a retry cannot fix). The operation is closed as failed. */
export class StripeRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`stripe rejected the request: ${reason}`);
    this.name = 'StripeRejectedError';
  }
}

/** The outcome is not known (timeout, connection, 5xx, rate limit, a request still in flight). The caller retries with the same key. */
export class StripeUncertainError extends Error {
  constructor(readonly reason: string) {
    super(`stripe outcome unknown: ${reason}`);
    this.name = 'StripeUncertainError';
  }
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('webhook signature could not be verified');
    this.name = 'WebhookSignatureError';
  }
}

export interface StripeGateway {
  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;
  /** Verifies the signature of the RAW body and returns the parsed event. Throws `WebhookSignatureError` (nothing about the body is exposed). */
  constructEvent(rawBody: Buffer, signatureHeader: string): unknown;
}

/** The idempotency key for a Checkout Session: stable per operation, never per attempt (money.md). Stripe keeps keys for at least 24 hours. */
export function checkoutIdempotencyKey(operationId: string): string {
  return `op-${operationId}`;
}

const DEFINITE_REJECTIONS = new Set(['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError']);

export function createStripeGateway(config: StripeConfig, client?: Stripe): StripeGateway {
  // No automatic retries: a retry inside the SDK would hide an uncertain result from us. The caller retries with the same idempotency key.
  const stripe = client ?? new Stripe(config.secretKey, { timeout: config.timeoutMs, maxNetworkRetries: 0 });
  return {
    async createCheckoutSession(request) {
      const metadata = { team_id: request.teamId, operation_id: request.operationId };
      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: 'payment',
            client_reference_id: request.operationId,
            line_items: [
              { quantity: 1, price_data: { currency: 'usd', unit_amount: request.amountCents, product_data: { name: request.productName } } },
            ],
            metadata,
            payment_intent_data: { metadata },
            success_url: request.successUrl,
            cancel_url: request.cancelUrl,
            expires_at: Math.floor(request.expiresAt.getTime() / 1000),
          },
          { idempotencyKey: checkoutIdempotencyKey(request.operationId) },
        );
      } catch (err) {
        const type = (err as { type?: unknown })?.type;
        if (typeof type === 'string' && DEFINITE_REJECTIONS.has(type)) throw new StripeRejectedError(type);
        throw new StripeUncertainError(typeof type === 'string' ? type : 'unknown_error');
      }
      // Stop at once if Stripe ever answers from live mode: this integration is test mode only.
      if (session.livemode) throw new StripeRejectedError('live_mode_session');
      if (!session.url) throw new StripeUncertainError('session_without_url');
      return { id: session.id, url: session.url };
    },

    constructEvent(rawBody, signatureHeader) {
      try {
        return stripe.webhooks.constructEvent(rawBody, signatureHeader, config.webhookSecret);
      } catch {
        throw new WebhookSignatureError();
      }
    },
  };
}
