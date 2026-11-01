// The one door to Stripe (AGENTS.md rules 6, 7, 10). Everything Stripe-shaped stays in this file so the rest of the billing code, and its tests,
// deal in plain objects. Two jobs: create a Checkout Session (the one synchronous provider call, bounded and idempotent) and verify a webhook's
// signature against the RAW body. Stripe only collects an amount WE calculated; this file never calculates one.
import Stripe from 'stripe';
import type { StripeApiConfig } from './stripeConfig.js';

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
  /** Save the card for later off-session charges (ADR 0030). Absent for a paid change, which saves nothing. */
  saveCard?: SaveCardRequest;
}

/** What it takes to save a card inside a Checkout page: the wording the buyer sees beside the pay button, and the team's Customer if it already has one. */
export interface SaveCardRequest {
  /** The consent wording (consent.ts), shown beside the confirm button and stored with the card. */
  consentText: string;
  /** The team's existing Stripe Customer, or null: Checkout then creates one (`customer_creation: 'always'`), so we make no second synchronous Stripe call. */
  customerId: string | null;
}

/** A "save a card" Checkout Session in setup mode: nothing is charged. */
export interface SetupRequest {
  setupId: string;
  teamId: string;
  successUrl: string;
  cancelUrl: string;
  /** Stored on the setup, so a retry sends exactly the same request. */
  expiresAt: Date;
  saveCard: SaveCardRequest;
}

/** What Stripe says about the intent that saved a card, read in the processing job. Only fields the job checks; no card number exists here. */
export interface SavedCardFacts {
  /** The intent's own status: `succeeded` is the only one that saved anything. */
  status: string;
  livemode: boolean;
  customerId: string | null;
  paymentMethodId: string | null;
  /** `card` is the only type we keep. */
  methodType: string | null;
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  metadata: Record<string, string>;
  /** `off_session` when the intent was made to allow later charges without the buyer. */
  usage: string | null;
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
  /** Checkout in setup mode: saves a card, charges nothing. The same bounded, idempotent call as `createCheckoutSession`. */
  createSetupSession(request: SetupRequest): Promise<CheckoutSession>;
  /** A READ, made by the processing job (never by a request): the SetupIntent a setup-mode Checkout made, with its card. */
  retrieveSetupIntentCard(setupIntentId: string): Promise<SavedCardFacts>;
  /** A READ, made by the processing job: the PaymentIntent an activation paid with, and the card it was saved from. */
  retrievePaymentIntentCard(paymentIntentId: string): Promise<SavedCardFacts>;
  /** Verifies the signature of the RAW body and returns the parsed event. Throws `WebhookSignatureError` (nothing about the body is exposed). */
  constructEvent(rawBody: Buffer, signatureHeader: string): unknown;
}

/** The idempotency key for a Checkout Session: stable per operation, never per attempt (money.md). Stripe keeps keys for at least 24 hours. */
export function checkoutIdempotencyKey(operationId: string): string {
  return `op-${operationId}`;
}

/** The idempotency key for a card-setup Checkout Session: stable per setup, never per attempt. */
export function setupIdempotencyKey(setupId: string): string {
  return `setup-${setupId}`;
}

const DEFINITE_REJECTIONS = new Set(['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError']);

/** Sorts a Stripe failure: a definite refusal (a retry cannot help) or an unknown outcome (the caller retries). */
function classify(err: unknown): never {
  const type = (err as { type?: unknown })?.type;
  if (typeof type === 'string' && DEFINITE_REJECTIONS.has(type)) throw new StripeRejectedError(type);
  throw new StripeUncertainError(typeof type === 'string' ? type : 'unknown_error');
}

/**
 * Rota takes cards only, in both Checkout modes: a renewal needs a saved card, and only a card is ever recorded (ADR 0030).
 * Only partly effective: Stripe's page still shows the Link button and a Bank row (ADR 0030, choice 9).
 * Stripe SDK 23 removed `payment_method_types` from Checkout; `allowed_payment_method_types` is its filter on the methods Checkout would offer.
 */
const CARD_ONLY: ['card'] = ['card'];

/** The Checkout parameters that make Stripe save the card and show the consent wording (the same in payment mode and setup mode). */
function saveCardParams(save: SaveCardRequest) {
  return {
    custom_text: { submit: { message: save.consentText } },
    ...(save.customerId ? { customer: save.customerId } : { customer_creation: 'always' as const }),
  };
}

function cardFacts(intent: Stripe.SetupIntent | Stripe.PaymentIntent, usage: string | null): SavedCardFacts {
  const pm = intent.payment_method && typeof intent.payment_method === 'object' ? intent.payment_method : null;
  const customer = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id ?? null;
  return {
    status: intent.status,
    livemode: intent.livemode,
    customerId: customer,
    paymentMethodId: pm?.id ?? (typeof intent.payment_method === 'string' ? intent.payment_method : null),
    methodType: pm?.type ?? null,
    card: pm?.card ? { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year } : null,
    metadata: (intent.metadata ?? {}) as Record<string, string>,
    usage,
  };
}

/** The API passes the webhook secret too; the worker passes none (it never verifies a webhook), and `constructEvent` then refuses everything. */
export function createStripeGateway(config: StripeApiConfig & { webhookSecret?: string }, client?: Stripe): StripeGateway {
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
            allowed_payment_method_types: CARD_ONLY,
            client_reference_id: request.operationId,
            line_items: [
              { quantity: 1, price_data: { currency: 'usd', unit_amount: request.amountCents, product_data: { name: request.productName } } },
            ],
            metadata,
            payment_intent_data: { metadata, ...(request.saveCard ? { setup_future_usage: 'off_session' as const } : {}) },
            ...(request.saveCard ? saveCardParams(request.saveCard) : {}),
            success_url: request.successUrl,
            cancel_url: request.cancelUrl,
            expires_at: Math.floor(request.expiresAt.getTime() / 1000),
          },
          { idempotencyKey: checkoutIdempotencyKey(request.operationId) },
        );
      } catch (err) {
        classify(err);
      }
      // Stop at once if Stripe ever answers from live mode: this integration is test mode only.
      if (session.livemode) throw new StripeRejectedError('live_mode_session');
      if (!session.url) throw new StripeUncertainError('session_without_url');
      return { id: session.id, url: session.url };
    },

    async createSetupSession(request) {
      // Session metadata is NOT documented as copied to the SetupIntent, so it is set on both explicitly (ADR 0030).
      const metadata = { team_id: request.teamId, card_setup_id: request.setupId };
      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: 'setup',
            allowed_payment_method_types: CARD_ONLY,
            currency: 'usd',
            client_reference_id: request.setupId,
            metadata,
            setup_intent_data: { metadata },
            ...saveCardParams(request.saveCard),
            success_url: request.successUrl,
            cancel_url: request.cancelUrl,
            expires_at: Math.floor(request.expiresAt.getTime() / 1000),
          },
          { idempotencyKey: setupIdempotencyKey(request.setupId) },
        );
      } catch (err) {
        classify(err);
      }
      if (session.livemode) throw new StripeRejectedError('live_mode_session');
      if (!session.url) throw new StripeUncertainError('session_without_url');
      return { id: session.id, url: session.url };
    },

    async retrieveSetupIntentCard(setupIntentId) {
      try {
        const intent = await stripe.setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
        return cardFacts(intent, intent.usage ?? null);
      } catch (err) {
        return classify(err);
      }
    },

    async retrievePaymentIntentCard(paymentIntentId) {
      try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
        return cardFacts(intent, intent.setup_future_usage ?? null);
      } catch (err) {
        return classify(err);
      }
    },

    constructEvent(rawBody, signatureHeader) {
      try {
        if (!config.webhookSecret) throw new Error('no webhook secret configured in this process');
        return stripe.webhooks.constructEvent(rawBody, signatureHeader, config.webhookSecret);
      } catch {
        throw new WebhookSignatureError();
      }
    },
  };
}
