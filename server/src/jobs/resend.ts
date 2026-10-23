/**
 * The Resend HTTP client (ADR 0016). Request shape and error names are from Resend's API reference and errors pages (read 2026-10-23):
 * POST https://api.resend.com/emails, `Authorization: Bearer <key>`, `Idempotency-Key`, body fields from / to / subject / html / text / reply_to.
 * The documented error JSON shape is not stated on those pages, so the error `name` is read defensively; the one real send confirms it.
 *
 * Every failure is classified once, here:
 *  - retryable: worth another attempt with the SAME idempotency key (the key makes a retry safe even if the first call was accepted and its
 *    answer lost): timeouts, network errors, 5xx, a per-second rate limit, a concurrent request with the same key;
 *  - terminal: a retry cannot help (bad request, bad or restricted key, a quota that resets at midnight UTC, a changed payload under one key).
 * Nothing here ever puts a recipient address, a link or a response body into an error message.
 */
export interface ResendPayload {
  from: string;
  replyTo?: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export class ResendError extends Error {
  constructor(
    readonly kind: 'retryable' | 'terminal',
    readonly reason: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`resend ${kind}: ${reason}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'ResendError';
  }
}

export interface ResendClient {
  send(request: { payload: ResendPayload; idempotencyKey: string }): Promise<{ id: string }>;
}

export interface ResendClientOptions {
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Maps an error response to retryable or terminal. `name` is Resend's error name when the body has one. */
export function classifyResendFailure(status: number, name: string | undefined, retryAfterSeconds?: number): ResendError {
  if (status === 429) {
    if (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded') {
      // Resets at midnight UTC (or next month): retrying in seconds is pointless, so do not burn the attempt budget.
      return new ResendError('terminal', name, status);
    }
    return new ResendError('retryable', name ?? 'rate_limited', status, retryAfterSeconds);
  }
  if (status === 409) {
    if (name === 'concurrent_idempotent_requests') return new ResendError('retryable', name, status);
    return new ResendError('terminal', name ?? 'conflict', status);
  }
  if (status >= 500) return new ResendError('retryable', name ?? 'server_error', status);
  // 400, 401, 403, 404, 422 and anything else: the request or the key is wrong, and it will be wrong again.
  return new ResendError('terminal', name ?? 'rejected', status);
}

export function createResendClient(options: ResendClientOptions): ResendClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? 'https://api.resend.com';

  return {
    async send({ payload, idempotencyKey }) {
      const body = {
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
      };

      let res: Response;
      try {
        res = await doFetch(`${base}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new ResendError('retryable', timedOut ? 'timeout' : 'network_error');
      }

      const text = await res.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }

      if (res.ok) {
        const id = typeof parsed === 'object' && parsed !== null ? (parsed as { id?: unknown }).id : undefined;
        if (typeof id !== 'string' || id === '') throw new ResendError('retryable', 'unreadable_success_response', res.status);
        return { id };
      }

      const name = typeof parsed === 'object' && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      throw classifyResendFailure(
        res.status,
        typeof name === 'string' ? name : undefined,
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined,
      );
    },
  };
}
