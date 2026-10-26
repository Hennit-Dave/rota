import { Router, type RequestHandler } from 'express';
import { ApiError } from '../http/errors.js';
import { jsonBody } from '../http/json.js';
import { recordRouteBase, type Logger } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { secondsUntilUtcMidnight } from '../invites/routes.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { clientIp, rateLimit, RateLimiterUnavailableError, type RateLimiter, type RateRule } from '../ratelimit/limiter.js';
import type { PasswordBlocklist } from './blocklist.js';
import type { AuthConfig } from './config.js';
import type { PasswordService } from './password.js';
import { findAccountByEmail, issueRecoveryEmail, redeemMagicLink, submitPasswordReset, type RecoveryDeps } from './recovery.js';
import type { RecoveryPurpose } from './recoveryEmail.js';
import { buildSessionResponse, userView } from './routes.js';
import { createAuthSchemas } from './schemas.js';
import type { TaskTracker } from './tasks.js';
import type { TokenService } from './tokens.js';

export interface RecoveryRouteDeps {
  /** Shard A's primary, via identityDb(). */
  db: PrismaClient;
  tokens: TokenService;
  passwords: PasswordService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  blocklist: PasswordBlocklist;
  recovery: RecoveryDeps;
  /** Runs the part of a request that happens after the answer (see requestRoute). Drained on shutdown. */
  tasks: TaskTracker;
  now?: () => Date;
}

const noStore: RequestHandler = (_req, res, next) => {
  // Responses carry sessions: never cacheable by anything between the server and the app.
  res.setHeader('Cache-Control', 'no-store');
  next();
};

const requestIdOf = (res: { locals: Record<string, unknown> }) => String(res.locals.requestId ?? '') || null;

/**
 * Magic link and password reset, mounted at /auth (ADR 0020). Every route is a public auth route: Zod, then rate limit, then handler (security.md).
 * A request answers the same `202 { ok: true }` whether or not the address has an account; only an existing account is emailed, from a job. A link
 * is only ever redeemed by one of the two POSTs below (the link itself opens an app screen), so opening it, or an email scanner fetching it,
 * consumes nothing.
 */
export function createRecoveryRouter(deps: RecoveryRouteDeps): Router {
  const { db, tokens, passwords, limiter, logger, config, blocklist, recovery, tasks } = deps;
  const now = deps.now ?? (() => new Date());
  const schemas = createAuthSchemas(config, blocklist);

  const router = Router();
  router.use(recordRouteBase);
  router.use(noStore);
  router.use(jsonBody());

  /**
   * Both request routes. Per-IP and per-address limits are counted for every well-formed request, known address or not, so a 429 reveals nothing.
   *
   * The answer is sent right after the account lookup, which both paths do, and the token, the email row and the job are made AFTER it, in a tracked
   * background step. Making them first would take about seven times longer for an address that has an account (measured, ADR 0020), and that
   * difference alone would tell anyone which addresses are registered (OWASP, Forgot Password Cheat Sheet). The cost: if the process dies in that
   * step, or the database refuses, the email is not sent and the person asks again; the failure is logged. Nothing is half-written: the token row and
   * the email row commit together or not at all.
   *
   * The app-wide daily cap (Resend's free plan, ADR 0020) is counted only when an email would really be sent; when it is spent the answer was
   * still the same 202 and the email is not made, so a cap that runs out cannot be used to tell which addresses have accounts.
   */
  function requestRoute(purpose: RecoveryPurpose, rules: (email: string, ip: string) => RateRule[]): RequestHandler[] {
    return [
      validateRequest({ body: schemas.recoveryRequest }),
      rateLimit(limiter, logger, (req) => rules((req.validated!.body as { email: string }).email, clientIp(req))),
      async (req, res) => {
        const { email } = req.validated!.body as { email: string };
        const requestId = String(res.locals.requestId ?? '');
        const account = await findAccountByEmail(db, email);
        if (account) {
          tasks.run(async () => {
            let capReached: boolean;
            try {
              const cap = await limiter.consume({
                name: 'auth_email_global',
                subject: 'global',
                max: config.recovery.globalDailyCap,
                windowSeconds: secondsUntilUtcMidnight(now()),
              });
              capReached = !cap.allowed;
            } catch (err) {
              if (err instanceof RateLimiterUnavailableError) {
                logger.error('recovery_email_not_made', { requestId, reason: 'rate_limiter_unavailable' });
                return;
              }
              throw err;
            }
            if (capReached) {
              logger.warn('recovery_email_cap_reached', { requestId, reason: purpose });
              return;
            }
            await issueRecoveryEmail(db, recovery, config, { purpose, user: account, requestId: requestId || null });
          });
        }
        res.status(202).json({ ok: true });
      },
    ];
  }

  // POST /auth/magic-link/request
  router.post(
    '/magic-link/request',
    ...requestRoute('magic_link', (email, ip) => [
      { name: 'magic_request_ip', subject: ip, ...config.rateLimits.magicRequestIp },
      { name: 'magic_request_email', subject: email, ...config.rateLimits.magicRequestEmail },
    ]),
  );

  // POST /auth/password-reset/request
  router.post(
    '/password-reset/request',
    ...requestRoute('password_reset', (email, ip) => [
      { name: 'reset_request_ip', subject: ip, ...config.rateLimits.resetRequestIp },
      { name: 'reset_request_email', subject: email, ...config.rateLimits.resetRequestEmail },
    ]),
  );

  // POST /auth/magic-link/redeem: the only thing that consumes a magic link. Answers like login.
  router.post(
    '/magic-link/redeem',
    validateRequest({ body: schemas.magicRedeem }),
    rateLimit(limiter, logger, (req) => [{ name: 'magic_redeem_ip', subject: clientIp(req), ...config.rateLimits.magicRedeemIp }]),
    async (req, res) => {
      const { token } = req.validated!.body as { token: string };
      const redeemed = await redeemMagicLink(db, config, { token, now: now() });
      if (!redeemed) throw new ApiError('link_unavailable');
      res.locals.userId = redeemed.user.id;
      res.json({
        user: userView({ ...redeemed.user, emailVerifiedAt: new Date() }),
        session: await buildSessionResponse(tokens, redeemed.user.id, redeemed.session.familyId, redeemed.session.refreshToken),
      });
    },
  );

  // POST /auth/password-reset/submit: consumes the token, sets the new password, ends every session. Does not sign anyone in.
  router.post(
    '/password-reset/submit',
    validateRequest({ body: schemas.resetSubmit }),
    rateLimit(limiter, logger, (req) => [{ name: 'reset_submit_ip', subject: clientIp(req), ...config.rateLimits.resetSubmitIp }]),
    async (req, res) => {
      const { token, password } = req.validated!.body as { token: string; password: string };
      const passwordHash = await passwords.hash(password);
      const done = await submitPasswordReset(db, config, { token, passwordHash });
      if (!done) throw new ApiError('link_unavailable');
      res.status(204).end();
    },
  );

  return router;
}
