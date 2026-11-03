/**
 * Push settings the worker reads at start (ADR 0032). A bad value stops the worker before it takes any work, like the email settings.
 *
 * PUSH_SEND_TIMEOUT_MS: how long one call to Expo may take. PROPOSED, CHOSEN, NOT MEASURED: the same 10 s as the email call (ADR 0016).
 * PUSH_RECEIPT_DELAY_MINUTES: how long after a send the receipts are fetched. 15 is Expo's own advice ("we recommend checking push receipts 15 minutes after
 * sending", Expo docs, read 2026-11-03); receipts are cleared after 24 hours.
 */
export const DEFAULT_PUSH_SEND_TIMEOUT_MS = 10_000;
export const DEFAULT_PUSH_RECEIPT_DELAY_MINUTES = 15;

export interface PushConfig {
  sendTimeoutMs: number;
  receiptDelayMs: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a whole number from 1 to ${max}, got "${raw}"`);
  return Number(raw);
}

export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  return {
    sendTimeoutMs: positiveInt(env, 'PUSH_SEND_TIMEOUT_MS', DEFAULT_PUSH_SEND_TIMEOUT_MS, 120_000),
    // Receipts are gone after 24 hours, so the delay may not go past that.
    receiptDelayMs: positiveInt(env, 'PUSH_RECEIPT_DELAY_MINUTES', DEFAULT_PUSH_RECEIPT_DELAY_MINUTES, 23 * 60) * 60_000,
  };
}
