// Stripe settings (ADR 0027). TEST MODE ONLY: a key that is not a test key stops the API before it listens, so a live key can never be used by mistake.
// This integration uses Stripe test mode only. Live-payment eligibility has not been verified.

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** How long one Stripe call may take. CHOSEN, NOT MEASURED (Dave, 2026-10-28). */
  timeoutMs: number;
}

/** Stripe's own prefixes: a secret test key (full access) or a restricted test key, and a webhook signing secret. Nothing else is accepted (issue: deploy-only restricted key). */
const TEST_KEY_PREFIXES = ['sk_test_', 'rk_test_'] as const;
const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** 10 seconds (Dave, 2026-10-28): CHOSEN, NOT MEASURED. */
const DEFAULT_TIMEOUT_MS = 10_000;

function requireTestKey(secretKey: string | undefined): string {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not set (a Stripe test key, sk_test_... or rk_test_...)');
  if (!TEST_KEY_PREFIXES.some((prefix) => secretKey.startsWith(prefix))) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_... or a restricted rk_test_...). Live keys are never accepted.');
  }
  return secretKey;
}

/** What the worker needs (ADR 0030): the test key and the timeout for the READS its processing job makes. It never holds the webhook signing secret. */
export type StripeApiConfig = Pick<StripeConfig, 'secretKey' | 'timeoutMs'>;

/**
 * Reads the key and the timeout only. Same rules as `loadStripeConfig`: a missing value, or any key that is not a test key, throws, and no message holds a value.
 */
export function loadStripeApiConfig(env: NodeJS.ProcessEnv = process.env): StripeApiConfig {
  const secretKey = requireTestKey(env.STRIPE_SECRET_KEY?.trim());
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.STRIPE_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('STRIPE_TIMEOUT_MS must be a positive whole number of milliseconds');
    timeoutMs = parsed;
  }
  return { secretKey, timeoutMs };
}

/**
 * Reads the Stripe settings. Every error message names the variable and the rule, never the value: a secret must not reach a log.
 * Throws on a missing value, on any key that is not `sk_test_...` or `rk_test_...` (including `sk_live_` and restricted live keys), and on a
 * webhook secret that is not `whsec_...`.
 */
export function loadStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const secretKey = requireTestKey(env.STRIPE_SECRET_KEY?.trim());
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set (the whsec_... secret that `stripe listen` prints)');
  if (!webhookSecret.startsWith(WEBHOOK_SECRET_PREFIX)) throw new Error('STRIPE_WEBHOOK_SECRET must start with whsec_');

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.STRIPE_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('STRIPE_TIMEOUT_MS must be a positive whole number of milliseconds');
    timeoutMs = parsed;
  }
  return { secretKey, webhookSecret, timeoutMs };
}
