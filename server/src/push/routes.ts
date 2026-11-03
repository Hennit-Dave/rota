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
import { deviceBody, registerDevice, unregisterDevice } from './devices.js';

export interface DeviceRouteDeps {
  shards: Shards;
  tokens: TokenService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
}

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * The device routes, mounted at /devices (ADR 0032). USER routes (security.md), in order: Zod, access token and session check, the per-user rate limit, handler.
 * No team and no role: a device belongs to the signed-in user, whose ID comes from the session and never from the request.
 *
 *   PUT  /devices             { expoToken }   register this device (idempotent; a token that was someone else's moves to the caller)
 *   POST /devices/unregister  { expoToken }   remove the caller's own registration (sign-out); POST because a DELETE body is not reliably carried
 */
export function createDeviceRouter(deps: DeviceRouteDeps): Router {
  const { shards, tokens, limiter, logger, config } = deps;
  const db = identityDb(shards);
  const requireAuth = createRequireAuth({ tokens, db });
  const writeLimit = rateLimit(limiter, logger, (req) => [{ name: 'devices_write_user', subject: req.auth!.userId, ...config.rateLimits.devicesWriteUser }]);

  const router = Router();
  router.use(recordRouteBase);
  router.use(noStore);
  router.use(jsonBody());

  router.put('/', validateRequest({ body: deviceBody }), requireAuth, writeLimit, async (req, res) => {
    await registerDevice(db, req.auth!.userId, (req.validated!.body as { expoToken: string }).expoToken);
    res.status(204).end();
  });

  router.post('/unregister', validateRequest({ body: deviceBody }), requireAuth, writeLimit, async (req, res) => {
    await unregisterDevice(db, req.auth!.userId, (req.validated!.body as { expoToken: string }).expoToken);
    res.status(204).end();
  });

  return router;
}
