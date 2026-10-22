/** Primitive-only fields: a log call can never be handed a token, a header or a body. */
export type LogFields = Record<string, string | number | boolean | null>;
export interface Logger {
  warn(event: string, fields?: LogFields): void;
}
export const silentLogger: Logger = { warn() {} };

/** The server answered with an error body: { error: { code, message, requestId, details? } } (ADR 0005). */
export class ApiError extends Error {
  readonly kind = 'api';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The device is offline: nothing was sent. The session and saved data are kept (app-state.md). */
export class OfflineError extends Error {
  readonly kind = 'offline';
  constructor() {
    super('The device is offline.');
    this.name = 'OfflineError';
  }
}

/** The request was (or may have been) sent but no answer arrived: timeout or dropped connection. */
export class NetworkError extends Error {
  readonly kind = 'network';
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** There are no tokens on the device. */
export class NotSignedInError extends Error {
  readonly kind = 'not_signed_in';
  constructor() {
    super('Not signed in.');
    this.name = 'NotSignedInError';
  }
}

/** The session is over and the device has been signed out locally (refresh was refused, or its result was unusable). */
export class SessionEndedError extends Error {
  readonly kind = 'session_ended';
  constructor(readonly reason: 'refresh_rejected' | 'refresh_malformed' | 'token_write_failed') {
    super(`Session ended: ${reason}.`);
    this.name = 'SessionEndedError';
  }
}

/** The refresh endpoint refused before consuming the token (429, 503). The session is kept; trying again is safe. */
export class RefreshUnavailableError extends Error {
  readonly kind = 'refresh_unavailable';
  constructor(readonly status: number, readonly retryAfterSeconds: number | null) {
    super(`Refresh unavailable (${status}).`);
    this.name = 'RefreshUnavailableError';
  }
}

/**
 * The refresh was sent but its outcome is unknown (response lost, timeout, unreadable answer). The old token may
 * already be consumed. Never replayed automatically (app-state.md): the next attempt is expected to fail as reuse,
 * and that 401 then signs the user out.
 */
export class RefreshUncertainError extends Error {
  readonly kind = 'refresh_uncertain';
  constructor(message: string) {
    super(message);
    this.name = 'RefreshUncertainError';
  }
}

/** The account changed (sign-out, or a switch) while this request was running. Its result is thrown away. */
export class StaleAccountError extends Error {
  readonly kind = 'stale_account';
  constructor() {
    super('The account changed while the request was running.');
    this.name = 'StaleAccountError';
  }
}

/** Only failures where trying again cannot do harm. Used by TanStack Query's `retry`. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500 && error.status !== 501;
  if (error instanceof NetworkError) return true;
  if (error instanceof RefreshUnavailableError) return true;
  return false;
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && isRetryable(error);
}
