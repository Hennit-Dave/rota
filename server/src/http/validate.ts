import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ApiError, type ErrorDetail } from './errors.js';

/**
 * Whole-request validation (security.md, brief Requirement 4): route params, query AND body, every route.
 * Schemas are strict objects, so an unknown key is an error. A part with no schema is validated against an
 * empty strict object, so "no body / no query" is enforced rather than ignored.
 */
export interface RequestSchemas<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> {
  params?: P;
  query?: Q;
  body?: B;
}

export interface Validated<P, Q, B> {
  params: P;
  query: Q;
  body: B;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by validateRequest. Handlers read only from here, never from req.body / req.query / req.params. */
    validated?: Validated<unknown, unknown, unknown>;
  }
}

/**
 * Turns Zod issues into `{ path, code, min?, max? }`. The submitted value is never included, and an
 * unknown key reports the parent path only (key names are attacker-controlled).
 */
export function toErrorDetails(error: z.ZodError, scope?: string): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map(String).join('.');
    const path = [scope, base].filter((p) => p).join('.');
    switch (issue.code) {
      case 'unrecognized_keys':
        out.push({ path, code: 'unrecognized_key' });
        break;
      case 'too_small':
        out.push({ path, code: 'too_short', min: Number(issue.minimum) });
        break;
      case 'too_big':
        out.push({ path, code: 'too_long', max: Number(issue.maximum) });
        break;
      case 'invalid_format':
        out.push({
          path,
          code:
            issue.format === 'email'
              ? 'invalid_email'
              : issue.format === 'uuid'
                ? 'invalid_uuid'
                : 'invalid_format',
        });
        break;
      case 'invalid_type':
        out.push({ path, code: 'invalid_type' });
        break;
      case 'custom': {
        // Only our own allow-listed codes pass through; anything else is the generic 'invalid'.
        const params = (issue as { params?: { rota?: unknown; min?: unknown; max?: unknown } }).params;
        const code = typeof params?.rota === 'string' && CUSTOM_CODES.has(params.rota) ? params.rota : 'invalid';
        const detail: ErrorDetail = { path, code };
        if (typeof params?.min === 'number') detail.min = params.min;
        if (typeof params?.max === 'number') detail.max = params.max;
        out.push(detail);
        break;
      }
      default:
        out.push({ path, code: 'invalid' });
    }
  }
  return out;
}

// Codes our own schemas may attach through `ctx.addIssue({ code: 'custom', params: { rota: ... } })`.
const CUSTOM_CODES: ReadonlySet<string> = new Set([
  'too_short',
  'too_long',
  'password_common',
  // Shifts (ADR 0021)
  'must_be_after_start',
  'break_too_long',
  'range_too_long',
  'not_a_member',
  'nothing_to_change',
  // The activity feed (ADR 0022)
  'limit_too_large',
  'invalid_cursor',
]);

const NOTHING = z.strictObject({});

export function validateRequest<
  P extends z.ZodType = typeof NOTHING,
  Q extends z.ZodType = typeof NOTHING,
  B extends z.ZodType = typeof NOTHING,
>(schemas: RequestSchemas<P, Q, B>): RequestHandler {
  const params = schemas.params ?? NOTHING;
  const query = schemas.query ?? NOTHING;
  const body = schemas.body ?? NOTHING;

  return (req, _res, next) => {
    const p = params.safeParse(req.params ?? {});
    const q = query.safeParse(req.query ?? {});
    // express.json() leaves req.body undefined when there was no JSON body; treat that as empty.
    const b = body.safeParse(req.body ?? {});

    if (p.success && q.success && b.success) {
      req.validated = { params: p.data, query: q.data, body: b.data };
      next();
      return;
    }

    const details = [
      ...(p.success ? [] : toErrorDetails(p.error, 'params')),
      ...(q.success ? [] : toErrorDetails(q.error, 'query')),
      ...(b.success ? [] : toErrorDetails(b.error)),
    ];
    next(new ApiError('validation_failed', { details }));
  };
}
