/**
 * Mail settings from the environment (AGENTS.md, Stack: Email). The sender and reply-to are not secrets and are frozen into every email's
 * payload by the API; the Resend key is a secret and exists only in the worker. A missing value stops the process before it starts work,
 * the same rule as the JWT secret.
 */
type Env = Record<string, string | undefined>;

// `Rota <notification@rota.davebuilds.design>` or a bare address. No control characters: this value ends up in a header.
const ADDRESS = /^(?:[^<>\r\n]*<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/;

function address(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  if (!ADDRESS.test(value)) throw new Error(`${name} must be an email address, optionally with a display name ("Name <address>").`);
  return value;
}

/** For the API: who the email is from and where replies go. */
export function loadSenderConfig(env: Env = process.env): { from: string; replyTo: string } {
  return { from: address(env, 'MAIL_FROM'), replyTo: address(env, 'MAIL_REPLY_TO') };
}

// Default 10 s: well under the 30 s work lease (WORK_LEASE_MS), so a hung call is abandoned before the lease could expire. A chosen ceiling,
// not a measurement; the proof run records real Resend latency in ADR 0016 and this is tuned from it.
export const DEFAULT_EMAIL_SEND_TIMEOUT_MS = 10_000;

/** For the worker: the Resend API key (secret) and the bound on one send. */
export function loadResendConfig(env: Env = process.env): { apiKey: string; timeoutMs: number } {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error('RESEND_API_KEY is not set.');
  const raw = env.EMAIL_SEND_TIMEOUT_MS;
  let timeoutMs = DEFAULT_EMAIL_SEND_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`EMAIL_SEND_TIMEOUT_MS must be a positive integer, got "${raw}"`);
    timeoutMs = Number(raw);
  }
  return { apiKey, timeoutMs };
}
