import type { PushChannelId, PushData } from './message.js';

/**
 * The Expo push client (ADR 0032). Request and answer shapes are from Expo's "Send notifications" page (read 2026-11-03): POST
 * https://exp.host/--/api/v2/push/send with up to 100 messages, one TICKET back per message in the same order; later POST .../getReceipts with up to 1000 ticket
 * ids. A ticket `ok` means Expo accepted the message, NOT that the phone has it; the receipt says what happened when Expo handed it to Google (FCM).
 * Enhanced push security (an access token) is not used: a known gap, recorded in ADR 0032.
 *
 * Every failure is classified once, here: a timeout, a network error, HTTP 429 and 5xx are `retryable`; HTTP 400 and any other 4xx are `terminal` (Expo: a 400 is
 * not retriable). A message or token never appears in an error text.
 */
export const MAX_MESSAGES_PER_REQUEST = 100;
export const MAX_RECEIPTS_PER_REQUEST = 1000;

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: PushData;
  /** The Android channel of this push's type (ADR 0033). A channel the device does not have drops the message silently, so the app creates them all before it registers. */
  channelId: PushChannelId | 'default';
}

export type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; error?: string };
export type Receipt = { status: 'ok' } | { status: 'error'; message: string; error?: string };

export class ExpoPushError extends Error {
  constructor(
    readonly kind: 'retryable' | 'terminal',
    readonly reason: string,
    readonly status?: number,
  ) {
    super(`expo push ${kind}: ${reason}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'ExpoPushError';
  }
}

export interface ExpoPushClient {
  send(messages: ExpoMessage[]): Promise<Ticket[]>;
  getReceipts(ids: string[]): Promise<Record<string, Receipt>>;
}

export interface ExpoPushClientOptions {
  timeoutMs: number;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function classifyExpoFailure(status: number): ExpoPushError {
  if (status === 429) return new ExpoPushError('retryable', 'rate_limited', status);
  if (status >= 500) return new ExpoPushError('retryable', 'server_error', status);
  return new ExpoPushError('terminal', 'rejected', status);
}

function asTicket(value: unknown): Ticket {
  const v = value as { status?: unknown; id?: unknown; message?: unknown; details?: { error?: unknown } } | null;
  if (v?.status === 'ok' && typeof v.id === 'string') return { status: 'ok', id: v.id };
  const error = typeof v?.details?.error === 'string' ? v.details.error : undefined;
  return { status: 'error', message: typeof v?.message === 'string' ? v.message.slice(0, 200) : 'unknown', ...(error ? { error } : {}) };
}

export function createExpoPushClient(options: ExpoPushClientOptions): ExpoPushClient {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? 'https://exp.host/--/api/v2/push';

  async function post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ExpoPushError('retryable', timedOut ? 'timeout' : 'network_error');
    }
    if (!response.ok) throw classifyExpoFailure(response.status);
    try {
      return await response.json();
    } catch {
      throw new ExpoPushError('retryable', 'unreadable_answer', response.status);
    }
  }

  return {
    async send(messages) {
      if (messages.length === 0) return [];
      if (messages.length > MAX_MESSAGES_PER_REQUEST) throw new Error(`at most ${MAX_MESSAGES_PER_REQUEST} messages per request`);
      const answer = (await post('send', messages)) as { data?: unknown };
      if (!Array.isArray(answer?.data) || answer.data.length !== messages.length) throw new ExpoPushError('retryable', 'unexpected_answer');
      return answer.data.map(asTicket);
    },
    async getReceipts(ids) {
      if (ids.length === 0) return {};
      if (ids.length > MAX_RECEIPTS_PER_REQUEST) throw new Error(`at most ${MAX_RECEIPTS_PER_REQUEST} receipts per request`);
      const answer = (await post('getReceipts', { ids })) as { data?: Record<string, unknown> };
      const out: Record<string, Receipt> = {};
      for (const [id, raw] of Object.entries(answer?.data ?? {})) {
        const status = (raw as { status?: unknown } | null)?.status;
        if (status === 'ok') out[id] = { status: 'ok' };
        else {
          const t = asTicket(raw);
          out[id] = t.status === 'error' ? t : { status: 'error', message: 'unknown' };
        }
      }
      return out;
    },
  };
}
