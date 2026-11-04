import { Router, type RequestHandler } from 'express';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { filtersHash } from '../cache/keys.js';
import type { TeamCache } from '../cache/store.js';
import { readContext, type ReadRouting } from '../db/readRouting.js';
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
  /** The read-routing function (ADR 0037): the feed is a routed read. */
  reads: ReadRouting;
  /** The team cache (ADR 0038): the FIRST page of the feed is cached. Later pages never are. */
  cache: TeamCache;
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
  const { shards, reads, cache, tokens, limiter, logger, config } = deps;
  const schemas = createActivitySchemas(deps.activity ?? loadActivityConfig());
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });
  const feedLimit = rateLimit(limiter, logger, (req) => [{ name: 'feed_user', subject: req.auth!.userId, ...config.rateLimits.feedUser }]);

  const router = Router({ mergeParams: true });
  router.use(noStore);

  router.get('/', validateRequest({ params: schemas.teamParams, query: schemas.query }), requireAuth, feedLimit, requireTeamRole('shifts.view'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const { limit, cursor } = req.validated!.query as { limit: number; cursor: Cursor | null };
    const userId = req.auth!.userId;
    // The membership and role were just checked on the primary. The rows themselves may come from the replica (ADR 0037); the user's own recent write sends the read to the primary.
    const read = (primary: boolean) => reads.run(teamId, readContext(res, userId, primary), (db) => listActivity(shards, { teamId, limit, cursor }, db));
    if (cursor !== null) {
      // A page after the first is never cached (caching.md): its cursor makes it too specific to be shared, and it is rarely asked twice.
      res.json(await read(false));
      return;
    }
    // The first page is the same for everyone who may see the feed, so it is one entry per team; the validated limit and a hash of the (today empty) filters are in the key.
    const { value, status } = await cache.get({
      kind: 'feed',
      teamId,
      scope: 'team',
      params: [String(limit), filtersHash({})],
      bypass: reads.decide(userId) !== 'none',
      load: ({ primary }) => read(primary),
    });
    res.locals.cache = status;
    res.json(value);
  });

  return router;
}
