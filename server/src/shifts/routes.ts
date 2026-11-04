import { Router, type RequestHandler } from 'express';
import type { TeamCache } from '../cache/store.js';
import { readContext, type ReadRouting } from '../db/readRouting.js';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { validateRequest } from '../http/validate.js';
import { createRequireTeamRole } from '../teams/middleware.js';
import { createRequireWritable } from '../teams/writeGuard.js';
import type { EnqueueRow } from '../billing/renewal.js';
import { createShiftSchemas } from './schemas.js';
import { loadShiftsConfig, type ShiftsConfig } from './config.js';
import { createShift, deleteShift, getShift, listShifts, listUpcomingShifts, updateShift, type NewShift, type ShiftPatch } from './service.js';

export interface ShiftsRouteDeps {
  shards: Shards;
  /** The read-routing function (ADR 0037): the calendar (list) is a routed read. */
  reads: ReadRouting;
  /** The team cache (ADR 0038): the calendar is cached, and every change here replaces its generation. */
  cache: TeamCache;
  tokens: TokenService;
  config?: ShiftsConfig;
  /** Puts a push event onto the queue after the shift change committed (ADR 0033). It never throws. */
  enqueue?: EnqueueRow;
  /** The clock `GET /upcoming` reads (its `asOf` and the start of its window). Tests set it; the default is the real time. */
  now?: () => Date;
}

// Shift data is the team's schedule: never cacheable between the server and the app.
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * The shift routes, mounted at /teams/:teamId/shifts (mergeParams). Team routes (security.md): Zod on params, query and body, then the access token and
 * session, then the caller's membership and role from the team shard's primary against the permission table. Everyone in the team may view
 * (`shifts.view`); only an Owner or Manager may publish, change or delete (`shifts.edit`). The team comes from the validated path, never the body.
 */
export function createShiftsRouter(deps: ShiftsRouteDeps): Router {
  const { shards, reads, cache, tokens } = deps;
  const config = deps.config ?? loadShiftsConfig();
  const schemas = createShiftSchemas(config);
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });
  const requireWritable = createRequireWritable({ shards });

  const router = Router({ mergeParams: true });
  router.use(noStore);

  // GET /teams/:teamId/shifts?from&to&mine
  router.get('/', validateRequest({ params: schemas.teamParams, query: schemas.list }), requireAuth, requireTeamRole('shifts.view'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const { from, to, mine } = req.validated!.query as { from: Date; to: Date; mine: boolean };
    const userId = req.auth!.userId;
    // The membership and role were just checked on the primary, and a cache hit never skips that. The key holds every input that shapes the answer: who it is
    // for (everyone in the team, or only this person with `mine`) and the exact range, as epoch milliseconds (the app asks for day-aligned weeks, so keys repeat).
    const { value, status } = await cache.get({
      kind: 'cal',
      teamId,
      scope: mine ? `user:${userId}` : 'team',
      params: [String(from.getTime()), String(to.getTime())],
      // The user's own 5 s window and the process's first 5 s: skip the cache entirely and do not fill it (caching.md).
      bypass: reads.decide(userId) !== 'none',
      load: ({ primary }) =>
        reads.run(teamId, readContext(res, userId, primary), (db) => listShifts(shards, { teamId, from, to, assignedUserId: mine ? userId : undefined }, db)).then((shifts) => ({ shifts })),
    });
    res.locals.cache = status;
    res.json(value);
  });

  // GET /teams/:teamId/shifts/upcoming: the caller's OWN shifts that have not ended, for the phone to keep for offline viewing (ADR 0034). Registered before
  // `/:shiftId`, so "upcoming" is never read as a shift ID. Everyone in the team may ask; whatever the role, it is only their own shifts.
  router.get('/upcoming', validateRequest({ params: schemas.teamParams, query: schemas.upcoming }), requireAuth, requireTeamRole('shifts.view'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const { team } = req.teamContext!;
    const asOf = (deps.now ?? (() => new Date()))();
    const shifts = await listUpcomingShifts(shards, { teamId, userId: req.auth!.userId, now: asOf, days: config.maxRangeDays });
    res.json({ asOf: asOf.toISOString(), team: { name: team.name, timeZone: team.timeZone }, shifts });
  });

  // GET /teams/:teamId/shifts/:shiftId (the shift screen, and later a tapped notification, open one shift directly)
  router.get('/:shiftId', validateRequest({ params: schemas.shiftParams }), requireAuth, requireTeamRole('shifts.view'), async (req, res) => {
    const { teamId, shiftId } = req.validated!.params as { teamId: string; shiftId: string };
    res.json({ shift: await getShift(shards, { teamId, shiftId }) });
  });

  // POST /teams/:teamId/shifts
  router.post('/', validateRequest({ params: schemas.teamParams, body: schemas.create }), requireAuth, requireTeamRole('shifts.edit'), requireWritable, async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const shift = await createShift(shards, { teamId, actorUserId: req.auth!.userId, shift: req.validated!.body as NewShift, enqueue: deps.enqueue, cache });
    res.status(201).json({ shift });
  });

  // PATCH /teams/:teamId/shifts/:shiftId
  router.patch(
    '/:shiftId',
    validateRequest({ params: schemas.shiftParams, body: schemas.update }),
    requireAuth,
    requireTeamRole('shifts.edit'),
    requireWritable,
    async (req, res) => {
      const { teamId, shiftId } = req.validated!.params as { teamId: string; shiftId: string };
      const shift = await updateShift(shards, { teamId, shiftId, actorUserId: req.auth!.userId, patch: req.validated!.body as ShiftPatch, enqueue: deps.enqueue, cache });
      res.json({ shift });
    },
  );

  // DELETE /teams/:teamId/shifts/:shiftId
  router.delete('/:shiftId', validateRequest({ params: schemas.shiftParams }), requireAuth, requireTeamRole('shifts.edit'), requireWritable, async (req, res) => {
    const { teamId, shiftId } = req.validated!.params as { teamId: string; shiftId: string };
    await deleteShift(shards, { teamId, shiftId, actorUserId: req.auth!.userId, enqueue: deps.enqueue, cache });
    res.status(204).end();
  });

  return router;
}
