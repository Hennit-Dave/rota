import type { AccountEpoch } from '../auth/epoch';
import type { TokenPair, TokenStore } from '../auth/types';
import {
  ApiError,
  NetworkError,
  NotSignedInError,
  OfflineError,
  RefreshUncertainError,
  RefreshUnavailableError,
  SessionEndedError,
  StaleAccountError,
  silentLogger,
  type Logger,
} from './errors';

/**
 * Why 15 s: the server waits up to 5 s to start an auth transaction (ADR 0005) and a cold Neon connection was
 * measured at 3.7 s. This is a chosen ceiling, not a measurement; tune it from real use (docs/STATE.md).
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiClientDeps {
  baseUrl: string;
  fetch: typeof fetch;
  tokens: TokenStore;
  epoch: AccountEpoch;
  /** Connectivity as TanStack's onlineManager sees it (fed by NetInfo). */
  isOnline(): boolean;
  /** The server (or an unusable refresh result) ended the session. Must perform the full local sign-out. */
  onSessionInvalid(reason: SessionEndedError['reason']): Promise<void>;
  timeoutMs?: number;
  logger?: Logger;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Attach the access token and refresh on 401. Defaults to true; false for public routes such as /health. */
  auth?: boolean;
  /** The caller's cancellation (TanStack passes one per query). */
  signal?: AbortSignal;
  /** Extra request headers (the swap request's `Idempotency-Key`). They are sent again unchanged if the request is replayed after a token refresh. Never `Authorization`. */
  headers?: Record<string, string>;
}

interface RawResponse {
  status: number;
  text: string;
  requestId: string | null;
  retryAfterSeconds: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseSession(text: string): TokenPair | null {
  const body = parseJson(text);
  const session = isRecord(body) ? body.session : undefined;
  if (!isRecord(session)) return null;
  const { accessToken, refreshToken } = session;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;
  return { accessToken, refreshToken };
}

function toApiError(raw: RawResponse): ApiError {
  const body = parseJson(raw.text);
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = typeof error?.code === 'string' ? error.code : 'unknown_error';
  const message = typeof error?.message === 'string' ? error.message : `Request failed (${raw.status}).`;
  const requestId = raw.requestId ?? (typeof error?.requestId === 'string' ? error.requestId : null);
  const bodyRetry = typeof error?.retryAfterSeconds === 'number' ? error.retryAfterSeconds : null;
  return new ApiError(raw.status, code, message, requestId, error?.details, raw.retryAfterSeconds ?? bodyRetry);
}

export function createApiClient(deps: ApiClientDeps) {
  const { baseUrl, tokens, epoch, isOnline, onSessionInvalid } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = deps.logger ?? silentLogger;

  async function send(
    path: string,
    method: string,
    body: unknown,
    accessToken: string | null,
    callerSignal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<RawResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort);

    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Set last: a caller's header can never replace the token (or leave one in when there should be none).
    delete headers.Authorization;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    try {
      const res = await deps.fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const retryAfter = Number(res.headers.get('Retry-After'));
      return {
        status: res.status,
        text,
        requestId: res.headers.get('X-Request-Id'),
        retryAfterSeconds: Number.isFinite(retryAfter) && res.headers.has('Retry-After') ? retryAfter : null,
      };
    } catch (error) {
      // The caller cancelled (a screen closed): pass that through so TanStack treats it as a cancellation.
      if (callerSignal?.aborted && !timedOut) throw error;
      throw new NetworkError(timedOut ? 'The request timed out.' : 'The connection failed.', timedOut);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** One round trip, then the stale-account check: a result for a previous account is thrown away. */
  async function exchange(
    path: string,
    options: RequestOptions,
    accessToken: string | null,
    epochAtStart: number,
  ): Promise<RawResponse> {
    const raw = await send(path, options.method ?? 'GET', options.body, accessToken, options.signal, options.headers);
    if (!epoch.isCurrent(epochAtStart)) throw new StaleAccountError();
    return raw;
  }

  // ---- refresh: at most one in flight -------------------------------------------------------------------------

  let inflightRefresh: Promise<TokenPair> | null = null;

  async function doRefresh(refreshToken: string, epochAtRefresh: number): Promise<TokenPair> {
    // Offline before anything is sent: the token is untouched, so the session and saved shifts are kept.
    if (!isOnline()) throw new OfflineError();

    let raw: RawResponse;
    try {
      raw = await send('/auth/refresh', 'POST', { refreshToken }, null);
    } catch (error) {
      // Sent, but no answer. The server may have rotated the token. Do not replay (app-state.md).
      throw new RefreshUncertainError(
        error instanceof NetworkError && error.timedOut ? 'The refresh timed out.' : 'The refresh connection failed.',
      );
    }

    if (raw.status === 200) {
      const pair = parseSession(raw.text);
      if (!pair) throw new RefreshUncertainError('The refresh answer could not be read.');
      // Signed out (or switched account) while the refresh ran: never write the old account's new tokens.
      if (!epoch.isCurrent(epochAtRefresh)) throw new StaleAccountError();
      try {
        await tokens.write(pair);
      } catch {
        // The old token is consumed and the new one could not be saved: the session cannot continue.
        await onSessionInvalid('token_write_failed');
        throw new SessionEndedError('token_write_failed');
      }
      return pair;
    }

    // ADR 0005: any 400 or 401 from /auth/refresh means sign out locally. A 400 also means the app sent a
    // malformed token, which is an app bug, so it is logged (without the token).
    if (raw.status === 400 || raw.status === 401) {
      if (!epoch.isCurrent(epochAtRefresh)) throw new StaleAccountError();
      const reason = raw.status === 400 ? 'refresh_malformed' : 'refresh_rejected';
      if (raw.status === 400) logger.warn('refresh_malformed_token', { status: 400, requestId: toApiError(raw).requestId });
      await onSessionInvalid(reason);
      throw new SessionEndedError(reason);
    }

    // 429 and 503: refused before the token was touched. Keep the session; trying again later is safe.
    if (raw.status === 429 || raw.status === 503) throw new RefreshUnavailableError(raw.status, raw.retryAfterSeconds);

    throw new RefreshUncertainError(`The refresh answered ${raw.status}.`);
  }

  async function ensureFreshTokens(epochAtStart: number, usedAccessToken: string): Promise<TokenPair> {
    const current = await tokens.read();
    if (!epoch.isCurrent(epochAtStart)) throw new StaleAccountError();
    if (!current) throw new NotSignedInError();
    // A refresh already finished while this request was in flight: use its tokens instead of refreshing again.
    if (current.accessToken !== usedAccessToken) return current;

    if (!inflightRefresh) {
      inflightRefresh = doRefresh(current.refreshToken, epoch.current).finally(() => {
        inflightRefresh = null;
      });
    }
    return inflightRefresh;
  }

  // ---- public ---------------------------------------------------------------------------------------------------

  async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const epochAtStart = epoch.current;
    const useAuth = options.auth !== false;

    if (!isOnline()) throw new OfflineError();

    let pair: TokenPair | null = null;
    if (useAuth) {
      pair = await tokens.read();
      if (!epoch.isCurrent(epochAtStart)) throw new StaleAccountError();
      if (!pair) throw new NotSignedInError();
    }

    let raw = await exchange(path, options, pair?.accessToken ?? null, epochAtStart);
    if (useAuth && pair && raw.status === 401) {
      const fresh = await ensureFreshTokens(epochAtStart, pair.accessToken);
      raw = await exchange(path, options, fresh.accessToken, epochAtStart);
    }

    if (raw.status >= 200 && raw.status < 300) {
      if (raw.status === 204 || raw.text === '') return undefined as T;
      const body = parseJson(raw.text);
      if (body === undefined) {
        throw new ApiError(raw.status, 'invalid_response', 'The server answer could not be read.', raw.requestId);
      }
      return body as T;
    }
    throw toApiError(raw);
  }

  return {
    request,
    get: <T = unknown>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...options, method: 'GET' }),
    post: <T = unknown>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...options, method: 'POST', body }),
    patch: <T = unknown>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
      request<T>(path, { ...options, method: 'PATCH', body }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
