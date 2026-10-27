import { Router, type RequestHandler } from 'express';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import type { Logger } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { rateLimit, type RateLimiter } from '../ratelimit/limiter.js';
import { createRequireTeamRole } from '../teams/middleware.js';
import { loadActivityConfig, type ActivityConfig } from './config.js';
import type { Cursor } from './cursor.js';
import { createActivitySchemas } from './schemas.js';
import { listActivity } from './service.js';

export interface ActivityRouteDeps {
  shards: Shards;
  tokens: TokenService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  activity?: ActivityConfig;
}

// The feed is the team's history: never cacheable between the server and the app (the server-side cache of its first page is a later slice).
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * GET /teams/:teamId/activity, mounted by the team router (mergeParams). A team route (security.md), in this order: Zod on params and query, the access
 * token and session, the per-user feed rate limit, then the caller's membership and role from the team shard's primary. Everyone in the team may read
 * (`shifts.view`). The limit is checked BEFORE the membership lookup so a flood is stopped before it reaches the database; the limiter fails CLOSED
 * (503 when Valkey is unreachable), like every limited route (ADR 0022, issue #11). The team comes from the validated path, never from the cursor.
 */
export function createActivityRouter(deps: ActivityRouteDeps): Router {
  const { shards, tokens, limiter, logger, config } = deps;
  const schemas = createActivitySchemas(deps.activity ?? loadActivityConfig());
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });
  const feedLimit = rateLimit(limiter, logger, (req) => [{ name: 'feed_user', subject: req.auth!.userId, ...config.rateLimits.feedUser }]);

  const router = Router({ mergeParams: true });
  router.use(noStore);

  router.get('/', validateRequest({ params: schemas.teamParams, query: schemas.query }), requireAuth, feedLimit, requireTeamRole('shifts.view'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const { limit, cursor } = req.validated!.query as { limit: number; cursor: Cursor | null };
    res.json(await listActivity(shards, { teamId, limit, cursor }));
  });

  return router;
}
