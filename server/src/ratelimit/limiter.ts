import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { sanitizeError } from '../jobs/redact.js';

/**
 * Rate limiting in Valkey, never in memory (AGENTS.md rule 12; security.md). Fixed-window counters:
 *
 *   SET key 0 EX <window> NX   creates the key WITH its TTL, only if absent
 *   INCR key                   counts this attempt
 *   PTTL key                   how long until the window resets
 *
 * Sent as one pipeline. No Lua is needed, and every key carries a TTL from the instant it exists (a crash
 * between the commands leaves a TTL'd key at 0, never an immortal one). The subject (an IP or an email) is
 * SHA-256 hashed into the key, so Valkey never holds a raw email and a hostile subject can't inject key text.
 *
 * Valkey unreachable, or rejecting the write under `noeviction`: the limiter throws
 * RateLimiterUnavailableError and the middleware answers 503. Everything on the limited list fails CLOSED
 * (security.md); it never lets the request through unchecked.
 */
export interface RateRule {
  /** Which limit this is, e.g. "login_ip". Used in the key and in logs; never the subject. */
  name: string;
  /** What is being counted: an IP, or a normalised email. Hashed before use. */
  subject: string;
  max: number;
  windowSeconds: number;
}

export interface RateResult {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`rate limiter unavailable: ${sanitizeError(cause)}`);
    this.name = 'RateLimiterUnavailableError';
  }
}

/** The subset of ioredis the limiter needs, so tests can substitute a fake. */
export interface RedisLike {
  pipeline(): {
    set(key: string, value: number, ex: 'EX', seconds: number, nx: 'NX'): unknown;
    incr(key: string): unknown;
    pttl(key: string): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Per-rule overrides of the configured thresholds. Used by tests to shrink a limit. */
export type RateRuleConfigOverrides = Partial<
  Record<| 'loginIp'
    | 'loginEmail'
    | 'registerIp'
    | 'refreshIp'
    | 'teamCreateUser'
    | 'feedUser'
    | 'swapRequestUser'
    | 'settingsReadUser'
    | 'settingsWriteUser'
    | 'inviteSendUser'
    | 'inviteSendTeam'
    | 'invitePreviewIp'
    | 'inviteAcceptUser'
    | 'inviteAcceptIp'
    | 'magicRequestIp'
    | 'magicRequestEmail'
    | 'magicRedeemIp'
    | 'resetRequestIp'
    | 'resetRequestEmail'
    | 'resetSubmitIp', { max: number; windowSeconds: number }>
>;

export interface RateLimiter {
  consume(rule: RateRule): Promise<RateResult>;
}

export interface RateLimiterOptions {
  /** Key prefix. Tests use a unique one so they can find and remove exactly their own keys. */
  prefix?: string;
  /** Called with every key touched. Tests use it to delete exact keys; never a wildcard DEL. */
  onKey?: (key: string) => void;
  /**
   * Called with the cause just before the limiter reports Valkey unavailable. The API uses it to replace a connection that went
   * half-open (recycleIfStale, issue #39). It must not throw and must not change the outcome: the request still fails closed.
   */
  onUnavailable?: (cause: unknown) => void;
}

export function rateLimitKey(prefix: string, name: string, subject: string): string {
  return `${prefix}:${name}:${createHash('sha256').update(subject).digest('hex')}`;
}

export function createRateLimiter(redis: RedisLike, options: RateLimiterOptions = {}): RateLimiter {
  const prefix = options.prefix ?? 'rl:v1';
  const unavailable = (cause: unknown) => {
    try {
      options.onUnavailable?.(cause);
    } catch {
      // A broken hook must never turn the fail-closed answer into something else.
    }
    return new RateLimiterUnavailableError(cause);
  };

  return {
    async consume(rule) {
      const key = rateLimitKey(prefix, rule.name, rule.subject);
      options.onKey?.(key);

      let results: Array<[Error | null, unknown]> | null;
      try {
        const pipe = redis.pipeline();
        pipe.set(key, 0, 'EX', rule.windowSeconds, 'NX');
        pipe.incr(key);
        pipe.pttl(key);
        results = await pipe.exec();
      } catch (err) {
        throw unavailable(err);
      }
      if (!results || results.length !== 3) {
        throw unavailable('empty pipeline result');
      }
      for (const [err] of results) {
        if (err) throw unavailable(err);
      }

      const count = Number(results[1]![1]);
      let pttl = Number(results[2]![1]);
      if (!Number.isFinite(count) || !Number.isFinite(pttl)) {
        throw unavailable('unexpected reply');
      }
      if (pttl < 0) {
        // -1: the key has no TTL (should not happen). -2: it expired between commands. Either way, make
        // sure it can never live forever (caching.md: every key has a TTL).
        try {
          await redis.expire(key, rule.windowSeconds);
        } catch (err) {
          throw unavailable(err);
        }
        pttl = rule.windowSeconds * 1000;
      }

      return {
        allowed: count <= rule.max,
        count,
        remaining: Math.max(0, rule.max - count),
        retryAfterSeconds: Math.max(1, Math.ceil(pttl / 1000)),
      };
    },
  };
}

/**
 * The caller's IP for rate limiting. This is the TCP peer address, never X-Forwarded-For: that header is
 * attacker-controlled until the host's proxy setup is verified (security.md). Behind a shared proxy every
 * client would share one address, so this must be revisited at deployment (issue #7). IPv4-mapped IPv6
 * ("::ffff:1.2.3.4") is folded to IPv4 so one client doesn't get two buckets.
 */
export function clientIp(req: Pick<Request, 'socket'>): string {
  const raw = req.socket.remoteAddress;
  if (!raw) return 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

/**
 * Express middleware. `buildRules` runs AFTER Zod validation (security.md pipeline: Zod, rate limit,
 * handler), so it can use the validated, normalised email. Every rule is counted even if an earlier one
 * already denied, so counters stay truthful. Runs before any password verification: a blocked attempt never
 * costs an Argon2 run.
 */
export function rateLimit(
  limiter: RateLimiter,
  logger: Logger,
  buildRules: (req: Request) => RateRule[],
): RequestHandler {
  return async (req, res, next) => {
    try {
      let worst: { rule: string; retryAfterSeconds: number } | null = null;
      for (const rule of buildRules(req)) {
        const result = await limiter.consume(rule);
        if (!result.allowed && (!worst || result.retryAfterSeconds > worst.retryAfterSeconds)) {
          worst = { rule: rule.name, retryAfterSeconds: result.retryAfterSeconds };
        }
      }
      if (worst) {
        logger.warn('rate_limited', {
          requestId: String(res.locals.requestId ?? ''),
          rule: worst.rule,
        });
        next(new ApiError('rate_limited', { retryAfterSeconds: worst.retryAfterSeconds }));
        return;
      }
      next();
    } catch (err) {
      if (err instanceof RateLimiterUnavailableError) {
        logger.error('rate_limiter_unavailable', {
          requestId: String(res.locals.requestId ?? ''),
          reason: err.message,
        });
        next(new ApiError('service_unavailable'));
        return;
      }
      next(err);
    }
  };
}
