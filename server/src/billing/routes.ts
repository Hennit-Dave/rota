import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { CANONICAL_UUID } from '../db/shard.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { rateLimit, type RateLimiter } from '../ratelimit/limiter.js';
import { idempotencyKey } from '../swaps/schemas.js';
import { createRequireTeamRole } from '../teams/middleware.js';
import { cancelOperation, getOperation, getOverview, quoteActivation, startActivation, type BillingDeps } from './activation.js';
import { getChangeQuote, getHistory, startChange } from './changes.js';
import { cancelReduction, scheduleReduction } from './reductions.js';
import { PLAN_IDS, type PlanId } from './plans.js';

export interface BillingRouteDeps {
  shards: Shards;
  tokens: TokenService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  billing: BillingDeps;
}

const uuid = z.string().regex(CANONICAL_UUID);
/**
 * A request-size bound, not a product limit: it keeps a monthly amount well inside the INTEGER cents columns and a typo from asking for a million seats.
 * CHOSEN, not measured; no plan sets a ceiling of its own (money.md).
 */
const MAX_SEATS_PER_REQUEST = 10_000;
const seats = z.number().int().min(1).max(MAX_SEATS_PER_REQUEST);

const schemas = {
  teamParams: z.strictObject({ teamId: uuid }),
  operationParams: z.strictObject({ teamId: uuid, operationId: uuid }),
  activation: z.strictObject({ plan: z.enum(PLAN_IDS), seats }),
  // The people chosen to become inactive. 100 is a request-size bound, not a product limit; the server checks the exact number needed against the members.
  reduction: z.strictObject({ plan: z.enum(PLAN_IDS), seats, selectedMemberIds: z.array(uuid).max(100), acceptFallback: z.boolean() }),
  // A query string value is text: digits only, then the same range as the body.
  quoteQuery: z.strictObject({
    plan: z.enum(PLAN_IDS),
    seats: z.string().regex(/^[0-9]{1,5}$/).transform(Number).pipe(seats),
  }),
};

/** Billing data is the team's private business, and a payment status must never be served stale (rule 11). */
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

const requireIdempotencyKey: RequestHandler = (req, res, next) => {
  const key = idempotencyKey(req.headers['idempotency-key']);
  if (!key) return next(new ApiError('validation_failed', { details: [{ path: 'header.idempotency-key', code: 'invalid' }] }));
  res.locals.idempotencyKey = key;
  next();
};

/**
 * The billing routes, mounted at /teams/:teamId/billing. Team routes (security.md), in this order: Zod, token and session, the per-user rate limit (writes),
 * membership and role from the team shard's primary. Owner alone manages billing (`billing.manage`). Which team, which plan and what it costs come from
 * the database and the engine, never from the request; the body names only the plan and the number of seats wanted.
 */
export function createBillingRouter(deps: BillingRouteDeps): Router {
  const { shards, tokens, limiter, logger, config, billing } = deps;
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });
  const writeLimit = rateLimit(limiter, logger, (req) => [{ name: 'billing_user', subject: req.auth!.userId, ...config.rateLimits.billingUser }]);

  const router = Router({ mergeParams: true });
  router.use(noStore);

  // GET /teams/:teamId/billing: what the team has and could buy, every price already formatted.
  router.get('/', validateRequest({ params: schemas.teamParams }), requireAuth, requireTeamRole('billing.manage'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    res.json(await getOverview(billing, teamId));
  });

  // GET /teams/:teamId/billing/activation-quote?plan=&seats=: the first period's charge, calculated by the server. Read-only.
  router.get('/activation-quote', validateRequest({ params: schemas.teamParams, query: schemas.quoteQuery }), requireAuth, requireTeamRole('billing.manage'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const query = req.validated!.query as { plan: PlanId; seats: number };
    res.json({ quote: await quoteActivation(billing, { teamId, plan: query.plan, seats: query.seats }) });
  });

  // GET /teams/:teamId/billing/change-quote?plan=&seats=: what a change would cost and when it would take effect, calculated by the server. Read-only.
  router.get('/change-quote', validateRequest({ params: schemas.teamParams, query: schemas.quoteQuery }), requireAuth, requireTeamRole('billing.manage'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const query = req.validated!.query as { plan: PlanId; seats: number };
    res.json({ quote: await getChangeQuote(billing, { teamId, plan: query.plan, seats: query.seats }) });
  });

  // POST /teams/:teamId/billing/changes   (Idempotency-Key header): a change that needs no payment applies now; a paid one freezes the quote and returns Checkout's URL.
  router.post(
    '/changes',
    validateRequest({ params: schemas.teamParams, body: schemas.activation }),
    requireIdempotencyKey,
    requireAuth,
    writeLimit,
    requireTeamRole('billing.manage'),
    async (req, res) => {
      const { teamId } = req.validated!.params as { teamId: string };
      const body = req.validated!.body as { plan: PlanId; seats: number };
      const answer = await startChange(billing, {
        teamId,
        actorUserId: req.auth!.userId,
        idempotencyKey: String(res.locals.idempotencyKey),
        plan: body.plan,
        seats: body.seats,
      });
      res.status(answer.status).json(answer.body);
    },
  );

  // POST /teams/:teamId/billing/reductions   (Idempotency-Key header): schedules a decrease for the end of the period and the people who become inactive.
  router.post(
    '/reductions',
    validateRequest({ params: schemas.teamParams, body: schemas.reduction }),
    requireIdempotencyKey,
    requireAuth,
    writeLimit,
    requireTeamRole('billing.manage'),
    async (req, res) => {
      const { teamId } = req.validated!.params as { teamId: string };
      const body = req.validated!.body as { plan: PlanId; seats: number; selectedMemberIds: string[]; acceptFallback: boolean };
      const answer = await scheduleReduction(billing, {
        teamId,
        actorUserId: req.auth!.userId,
        idempotencyKey: String(res.locals.idempotencyKey),
        plan: body.plan,
        seats: body.seats,
        selectedMemberIds: body.selectedMemberIds,
        acceptFallback: body.acceptFallback,
      });
      res.status(answer.status).json(answer.body);
    },
  );

  // DELETE /teams/:teamId/billing/reductions/current: takes back the scheduled reduction, while it is still only scheduled.
  router.delete('/reductions/current', validateRequest({ params: schemas.teamParams }), requireAuth, writeLimit, requireTeamRole('billing.manage'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    await cancelReduction(billing, { teamId });
    res.status(204).end();
  });

  // GET /teams/:teamId/billing/history: charges, credits, refunds and plan or seat changes, newest first, from the ledger.
  router.get('/history', validateRequest({ params: schemas.teamParams }), requireAuth, requireTeamRole('billing.manage'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    res.json(await getHistory(billing, teamId));
  });

  // POST /teams/:teamId/billing/activation   (Idempotency-Key header): freezes the quote and returns Stripe's Checkout URL.
  router.post(
    '/activation',
    validateRequest({ params: schemas.teamParams, body: schemas.activation }),
    requireIdempotencyKey,
    requireAuth,
    writeLimit,
    requireTeamRole('billing.manage'),
    async (req, res) => {
      const { teamId } = req.validated!.params as { teamId: string };
      const body = req.validated!.body as { plan: PlanId; seats: number };
      const answer = await startActivation(billing, {
        teamId,
        actorUserId: req.auth!.userId,
        idempotencyKey: String(res.locals.idempotencyKey),
        plan: body.plan,
        seats: body.seats,
      });
      res.status(answer.status).json(answer.body);
    },
  );

  // GET /teams/:teamId/billing/operations/:operationId: the server says awaiting_payment, confirming, paid, failed, expired or under_review.
  router.get('/operations/:operationId', validateRequest({ params: schemas.operationParams }), requireAuth, requireTeamRole('billing.manage'), async (req, res) => {
    const { teamId, operationId } = req.validated!.params as { teamId: string; operationId: string };
    res.json({ operation: await getOperation(billing, { teamId, operationId }) });
  });

  // POST /teams/:teamId/billing/operations/:operationId/cancel: the buyer backed out of Stripe's page.
  router.post('/operations/:operationId/cancel', validateRequest({ params: schemas.operationParams }), requireAuth, writeLimit, requireTeamRole('billing.manage'), async (req, res) => {
    const { teamId, operationId } = req.validated!.params as { teamId: string; operationId: string };
    res.json({ operation: await cancelOperation(billing, { teamId, operationId }) });
  });

  return router;
}
