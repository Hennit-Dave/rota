import type { ErrorRequestHandler, RequestHandler } from 'express';
import { sanitizeError } from '../jobs/redact.js';
import type { Logger } from './logger.js';

/**
 * The one error vocabulary the app switches on (ADR 0005). The public code is deliberately coarse where a
 * finer one would help an attacker: every refresh or access-token failure is `unauthenticated`, and the real
 * reason goes to the server log only.
 */
export type ErrorCode =
  | 'validation_failed'
  | 'invalid_json'
  | 'payload_too_large'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'forbidden'
  | 'invite_unavailable'
  | 'link_unavailable'
  | 'invite_wrong_account'
  | 'already_member'
  | 'invite_pending'
  | 'email_in_use'
  | 'not_found'
  | 'rate_limited'
  | 'internal_error'
  | 'service_unavailable';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  invalid_json: 400,
  payload_too_large: 413,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  invite_unavailable: 404,
  link_unavailable: 404,
  invite_wrong_account: 403,
  already_member: 409,
  invite_pending: 409,
  email_in_use: 409,
  not_found: 404,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
};

// Safe English defaults for debugging. The app owns the user-facing copy and switches on `code`.
const MESSAGE: Record<ErrorCode, string> = {
  validation_failed: 'The request was not valid.',
  invalid_json: 'The request body is not valid JSON.',
  payload_too_large: 'The request body is too large.',
  unauthenticated: 'Authentication is required.',
  invalid_credentials: 'Email or password is incorrect.',
  forbidden: 'Your role does not allow this.',
  invite_unavailable: 'This invitation is not available.',
  link_unavailable: 'This link is not available.',
  invite_wrong_account: 'This invitation is for a different account.',
  already_member: 'This person is already on the team.',
  invite_pending: 'An invitation is already pending for this email.',
  email_in_use: 'An account with this email already exists.',
  not_found: 'Not found.',
  rate_limited: 'Too many requests. Try again later.',
  internal_error: 'Something went wrong.',
  service_unavailable: 'The service is temporarily unavailable.',
};

/** One field-level problem. Never carries the submitted value (security.md: don't echo input). */
export interface ErrorDetail {
  path: string;
  code: string;
  min?: number;
  max?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];
  readonly retryAfterSeconds?: number;
  /** Server-side only: logged, never sent. For example why a refresh failed (`reuse_detected`). */
  readonly reason?: string;

  constructor(
    code: ErrorCode,
    options?: { details?: ErrorDetail[]; retryAfterSeconds?: number; reason?: string },
  ) {
    super(MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.reason = options?.reason;
  }
}

/** Express 5 forwards rejected promises from async handlers to the error handler, so no wrapper is needed. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new ApiError('not_found'));
};

/** Maps the errors Express' JSON body parser raises (it sets `type`) onto our codes. */
function fromBodyParserError(err: unknown): ApiError | null {
  if (typeof err !== 'object' || err === null) return null;
  const type = (err as { type?: unknown }).type;
  if (type === 'entity.parse.failed') return new ApiError('invalid_json');
  if (type === 'entity.too.large') return new ApiError('payload_too_large');
  if (typeof type === 'string' && type.startsWith('encoding.')) return new ApiError('validation_failed');
  if (typeof type === 'string' && type.startsWith('charset.')) return new ApiError('validation_failed');
  return null;
}

/**
 * Prisma raises P2028 when an interactive transaction could not start in time (a cold database connection can
 * take longer than the default 2 s wait) or ran past its timeout; either way it rolled back. That is the
 * database being briefly unavailable, not a bug in the request: 503, so the app retries.
 */
function fromTransactionUnavailable(err: unknown): ApiError | null {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2028') return null;
  return new ApiError('service_unavailable', { reason: 'database_transaction_unavailable' });
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by its four parameters, so `_next` must stay.
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const requestId = String(res.locals.requestId ?? '');
    let apiError: ApiError | null =
      err instanceof ApiError ? err : (fromBodyParserError(err) ?? fromTransactionUnavailable(err));

    if (!apiError) {
      // Unexpected: log a sanitized message for us, tell the caller nothing about it.
      logger.error('unhandled_error', { requestId, reason: sanitizeError(err) });
      apiError = new ApiError('internal_error');
    } else if (apiError.reason) {
      // Expected-but-noteworthy (e.g. refresh rejected): the true reason stays server-side.
      logger.warn('request_rejected', { requestId, errorCode: apiError.code, reason: apiError.reason });
    }

    res.locals.errorCode = apiError.code;
    if (apiError.code === 'unauthenticated') {
      res.setHeader('WWW-Authenticate', 'Bearer');
    }
    if (apiError.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(apiError.retryAfterSeconds));
    }
    res.status(apiError.status).json({
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId,
        ...(apiError.details ? { details: apiError.details } : {}),
        ...(apiError.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: apiError.retryAfterSeconds }
          : {}),
      },
    });
  };
}
