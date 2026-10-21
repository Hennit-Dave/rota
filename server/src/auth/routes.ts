import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { jsonBody } from '../http/json.js';
import { recordRouteBase, type Logger } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { clientIp, rateLimit, type RateLimiter } from '../ratelimit/limiter.js';
import type { PasswordBlocklist } from './blocklist.js';
import type { AuthConfig } from './config.js';
import { createRequireAuth } from './middleware.js';
import type { PasswordService } from './password.js';
import { createAuthSchemas } from './schemas.js';
import { createSession } from './sessions.js';
import type { TokenService } from './tokens.js';

export interface AuthDeps {
  /** Shard A's primary, via identityDb(). Every identity read and write goes through it. */
  db: PrismaClient;
  tokens: TokenService;
  passwords: PasswordService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  blocklist: PasswordBlocklist;
  now?: () => Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
}

function userView(u: UserRow) {
  return { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerifiedAt !== null };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

const noStore: RequestHandler = (_req, res, next) => {
  // Responses carry tokens: never cacheable by anything between the server and the app.
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createAuthRouter(deps: AuthDeps): Router {
  const { db, tokens, passwords, limiter, logger, config, blocklist } = deps;
  const now = deps.now ?? (() => new Date());
  const schemas = createAuthSchemas(config, blocklist);
  const requireAuth = createRequireAuth({ tokens, db });

  async function sessionResponse(userId: string, familyId: string, refreshToken: string) {
    const access = await tokens.sign({ userId, familyId });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
    };
  }

  const router = Router();
  router.use(recordRouteBase);
  router.use(noStore);
  router.use(jsonBody());

  // POST /auth/register: public auth route. Zod, then rate limit, then handler (security.md).
  router.post(
    '/register',
    validateRequest({ body: schemas.register }),
    rateLimit(limiter, logger, (req) => [
      { name: 'register_ip', subject: clientIp(req), ...config.rateLimits.registerIp },
    ]),
    async (req, res) => {
      const { name, email, password } = req.validated!.body as { name: string; email: string; password: string };
      const passwordHash = await passwords.hash(password);

      let created;
      try {
        created = await db.$transaction(async (tx) => {
          const user = await tx.user.create({ data: { email, name } });
          await tx.credential.create({ data: { userId: user.id, passwordHash } });
          const session = await createSession(tx, { userId: user.id, config, now: now() });
          return { user, session };
        });
      } catch (err) {
        // The unique index on users.email is what makes this race-free: two simultaneous registrations of one
        // address give exactly one success. 409 reveals that an address has an account: an accepted trade-off (ADR 0005).
        if (isUniqueViolation(err)) throw new ApiError('email_in_use');
        throw err;
      }

      res.locals.userId = created.user.id;
      res.status(201).json({
        user: userView(created.user),
        session: await sessionResponse(created.user.id, created.session.familyId, created.session.refreshToken),
      });
    },
  );

  // POST /auth/login: public auth route. Rate limiting runs BEFORE any password verification.
  router.post(
    '/login',
    validateRequest({ body: schemas.login }),
    rateLimit(limiter, logger, (req) => [
      { name: 'login_ip', subject: clientIp(req), ...config.rateLimits.loginIp },
      {
        name: 'login_email',
        subject: (req.validated!.body as { email: string }).email,
        ...config.rateLimits.loginEmail,
      },
    ]),
    async (req, res) => {
      const { email, password } = req.validated!.body as { email: string; password: string };
      const user = await db.user.findUnique({ where: { email }, include: { credential: true } });

      // Exactly one Argon2 verification runs whether or not the account exists (dummy hash otherwise).
      const verified = await passwords.verifyAgainst(user?.credential?.passwordHash ?? null, password);
      if (!user || !verified) {
        // One generic failure for "no such user" and "wrong password" (security.md). The reason is for our log
        // only, and it carries the user ID (never the email).
        logger.warn('login_failed', {
          requestId: String(res.locals.requestId ?? ''),
          ...(user ? { userId: user.id } : {}),
          reason: !user ? 'unknown_email' : !user.credential ? 'no_credential' : 'bad_password',
        });
        throw new ApiError('invalid_credentials');
      }

      const session = await db.$transaction((tx) => createSession(tx, { userId: user.id, config, now: now() }));
      res.locals.userId = user.id;
      res.json({
        user: userView(user),
        session: await sessionResponse(user.id, session.familyId, session.refreshToken),
      });
    },
  );

  // GET /auth/me: user route. Access token, then the session check, then the handler.
  router.get('/me', validateRequest({}), requireAuth, async (req, res) => {
    const user = await db.user.findUnique({ where: { id: req.auth!.userId } });
    if (!user) throw new ApiError('unauthenticated', { reason: 'user_missing' });
    res.json({ user: userView(user) });
  });

  return router;
}
