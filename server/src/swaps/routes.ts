import { Router, type RequestHandler } from 'express';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { rateLimit, type RateLimiter } from '../ratelimit/limiter.js';
import { createRequireTeamRole } from '../teams/middleware.js';
import { loadSwapsConfig, type SwapsConfig } from './config.js';
import { createSwapSchemas, idempotencyKey } from './schemas.js';
import { cancelSwap, createSwap, decideSwap, getSwap, listSwaps } from './service.js';

export interface SwapsRouteDeps {
  shards: Shards;
  tokens: TokenService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  swaps?: SwapsConfig;
}

// Swaps are the team's private business: never cacheable between the server and the app.
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** The `Idempotency-Key` header, validated like the rest of the request (a 400 before anything else is looked at), and kept for the handler. */
const requireIdempotencyKey: RequestHandler = (req, res, next) => {
  const key = idempotencyKey(req.headers['idempotency-key']);
  if (!key) return next(new ApiError('validation_failed', { details: [{ path: 'header.idempotency-key', code: 'invalid' }] }));
  res.locals.idempotencyKey = key;
  next();
};

/**
 * The swap routes, mounted at /teams/:teamId/swaps (mergeParams). Team routes (security.md), in this order: Zod, token and session, the rate limit (creating
 * only), membership and role from the team shard's primary against the permission table. Anyone in the team may ask for a swap and read their own
 * (`swaps.request`); only an Owner or Manager may approve or reject (`swaps.approve`), and the service refuses a decision by someone who is part of the
 * swap. Who is asking, who the other person is and who may decide come from the database, never from the request.
 */
export function createSwapsRouter(deps: SwapsRouteDeps): Router {
  const { shards, tokens, limiter, logger, config } = deps;
  const swapsConfig = deps.swaps ?? loadSwapsConfig();
  const schemas = createSwapSchemas();
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });
  const requestLimit = rateLimit(limiter, logger, (req) => [{ name: 'swap_request_user', subject: req.auth!.userId, ...config.rateLimits.swapRequestUser }]);
  const caller = (req: Parameters<RequestHandler>[0]) => ({ userId: req.auth!.userId, role: req.teamContext!.role });

  const router = Router({ mergeParams: true });
  router.use(noStore);

  // GET /teams/:teamId/swaps
  router.get('/', validateRequest({ params: schemas.teamParams }), requireAuth, requireTeamRole('swaps.request'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    res.json({ swaps: await listSwaps(shards, { teamId, caller: caller(req), limit: swapsConfig.listLimit }) });
  });

  // GET /teams/:teamId/swaps/:swapId
  router.get('/:swapId', validateRequest({ params: schemas.swapParams }), requireAuth, requireTeamRole('swaps.request'), async (req, res) => {
    const { teamId, swapId } = req.validated!.params as { teamId: string; swapId: string };
    res.json({ swap: await getSwap(shards, { teamId, swapId, caller: caller(req) }) });
  });

  // POST /teams/:teamId/swaps   (Idempotency-Key header)
  router.post(
    '/',
    validateRequest({ params: schemas.teamParams, body: schemas.create }),
    requireIdempotencyKey,
    requireAuth,
    requestLimit,
    requireTeamRole('swaps.request'),
    async (req, res) => {
      const { teamId } = req.validated!.params as { teamId: string };
      const body = req.validated!.body as { offeredShiftId: string; requestedShiftId: string };
      const result = await createSwap(shards, {
        teamId,
        caller: caller(req),
        idempotencyKey: String(res.locals.idempotencyKey),
        offeredShiftId: body.offeredShiftId,
        requestedShiftId: body.requestedShiftId,
        maxPending: swapsConfig.maxPending,
        maxWaitMs: config.transactionMaxWaitMs,
      });
      // 201 when this call made the request, 200 when it is the stored answer to a repeat of the same key.
      res.status(result.created ? 201 : 200).json({ swap: result.swap });
    },
  );

  // POST /teams/:teamId/swaps/:swapId/cancel
  router.post('/:swapId/cancel', validateRequest({ params: schemas.swapParams }), requireAuth, requireTeamRole('swaps.request'), async (req, res) => {
    const { teamId, swapId } = req.validated!.params as { teamId: string; swapId: string };
    res.json({ swap: await cancelSwap(shards, { teamId, swapId, caller: caller(req) }) });
  });

  // POST /teams/:teamId/swaps/:swapId/approve and /reject
  for (const decision of ['approve', 'reject'] as const) {
    router.post(`/:swapId/${decision}`, validateRequest({ params: schemas.swapParams }), requireAuth, requireTeamRole('swaps.approve'), async (req, res) => {
      const { teamId, swapId } = req.validated!.params as { teamId: string; swapId: string };
      res.json({ swap: await decideSwap(shards, { teamId, swapId, caller: caller(req), decision, maxWaitMs: config.transactionMaxWaitMs }) });
    });
  }

  return router;
}
