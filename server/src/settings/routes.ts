import { Router, type RequestHandler } from 'express';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { jsonBody } from '../http/json.js';
import { recordRouteBase, type Logger } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { rateLimit, type RateLimiter } from '../ratelimit/limiter.js';
import { updateBody } from './schemas.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import type { ShardId } from '../db/shard.js';
import { reschedulePushRows } from '../push/reschedule.js';
import { changeSetting, getSettings } from './service.js';

export interface SettingsRouteDeps {
  shards: Shards;
  tokens: TokenService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  /** Enqueues a work row after its transaction committed; it never throws (jobs.md). Used for the pushes a quiet-hours or time-zone change moves. */
  enqueue?: (prisma: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => Promise<void>;
}

// A user's settings are private to them: never cacheable between the server and the app.
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * The settings routes, mounted at /settings. USER routes (security.md), in this order: Zod, access token and session check, the per-user rate limit,
 * handler. There is no team and no role here: settings belong to the signed-in user, whose ID comes from the session and never from the request, so
 * there is no way to name somebody else's settings. The quiet-hours and time-zone values are enforced by the push job later (ADR 0024, jobs.md); this
 * module only stores them.
 */
export function createSettingsRouter(deps: SettingsRouteDeps): Router {
  const { shards, tokens, limiter, logger, config } = deps;
  const db = identityDb(shards);
  const requireAuth = createRequireAuth({ tokens, db });
  const readLimit = rateLimit(limiter, logger, (req) => [{ name: 'settings_read_user', subject: req.auth!.userId, ...config.rateLimits.settingsReadUser }]);
  const writeLimit = rateLimit(limiter, logger, (req) => [{ name: 'settings_write_user', subject: req.auth!.userId, ...config.rateLimits.settingsWriteUser }]);

  const router = Router();
  router.use(recordRouteBase);
  router.use(noStore);
  router.use(jsonBody());

  // GET /settings
  router.get('/', validateRequest({}), requireAuth, readLimit, async (req, res) => {
    res.json({ settings: await getSettings(db, req.auth!.userId) });
  });

  // PATCH /settings   { <one field>: value }
  router.patch('/', validateRequest({ body: updateBody }), requireAuth, writeLimit, async (req, res) => {
    const userId = req.auth!.userId;
    const change = req.validated!.body as Parameters<typeof changeSetting>[2];
    if (!('quietHours' in change || 'timeZone' in change)) {
      res.json({ settings: await changeSetting(db, userId, change) });
      return;
    }
    // Quiet hours and the time zone decide WHEN waiting pushes may be sent, so the new value and the new schedule commit together (jobs.md, ADR 0032).
    const { settings, moved } = await db.$transaction(
      async (tx) => {
        const next = await changeSetting(tx as PrismaClient, userId, change);
        return { settings: next, moved: await reschedulePushRows(tx, userId, next, new Date()) };
      },
      { maxWait: config.transactionMaxWaitMs, timeout: 15_000 },
    );
    // After the commit; never throws: a Valkey failure leaves the row for the sweep.
    if (deps.enqueue) for (const row of moved) await deps.enqueue(db, row, 'A');
    res.json({ settings });
  });

  return router;
}
