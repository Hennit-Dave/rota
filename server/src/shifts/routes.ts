import { Router, type RequestHandler } from 'express';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { validateRequest } from '../http/validate.js';
import { createRequireTeamRole } from '../teams/middleware.js';
import { createShiftSchemas } from './schemas.js';
import { loadShiftsConfig, type ShiftsConfig } from './config.js';
import { createShift, deleteShift, getShift, listShifts, updateShift, type NewShift, type ShiftPatch } from './service.js';

export interface ShiftsRouteDeps {
  shards: Shards;
  tokens: TokenService;
  config?: ShiftsConfig;
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
  const { shards, tokens } = deps;
  const config = deps.config ?? loadShiftsConfig();
  const schemas = createShiftSchemas(config);
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });

  const router = Router({ mergeParams: true });
  router.use(noStore);

  // GET /teams/:teamId/shifts?from&to&mine
  router.get('/', validateRequest({ params: schemas.teamParams, query: schemas.list }), requireAuth, requireTeamRole('shifts.view'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const { from, to, mine } = req.validated!.query as { from: Date; to: Date; mine: boolean };
    const shifts = await listShifts(shards, { teamId, from, to, assignedUserId: mine ? req.auth!.userId : undefined });
    res.json({ shifts });
  });

  // GET /teams/:teamId/shifts/:shiftId (the shift screen, and later a tapped notification, open one shift directly)
  router.get('/:shiftId', validateRequest({ params: schemas.shiftParams }), requireAuth, requireTeamRole('shifts.view'), async (req, res) => {
    const { teamId, shiftId } = req.validated!.params as { teamId: string; shiftId: string };
    res.json({ shift: await getShift(shards, { teamId, shiftId }) });
  });

  // POST /teams/:teamId/shifts
  router.post('/', validateRequest({ params: schemas.teamParams, body: schemas.create }), requireAuth, requireTeamRole('shifts.edit'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const shift = await createShift(shards, { teamId, actorUserId: req.auth!.userId, shift: req.validated!.body as NewShift });
    res.status(201).json({ shift });
  });

  // PATCH /teams/:teamId/shifts/:shiftId
  router.patch(
    '/:shiftId',
    validateRequest({ params: schemas.shiftParams, body: schemas.update }),
    requireAuth,
    requireTeamRole('shifts.edit'),
    async (req, res) => {
      const { teamId, shiftId } = req.validated!.params as { teamId: string; shiftId: string };
      const shift = await updateShift(shards, { teamId, shiftId, actorUserId: req.auth!.userId, patch: req.validated!.body as ShiftPatch });
      res.json({ shift });
    },
  );

  // DELETE /teams/:teamId/shifts/:shiftId
  router.delete('/:shiftId', validateRequest({ params: schemas.shiftParams }), requireAuth, requireTeamRole('shifts.edit'), async (req, res) => {
    const { teamId, shiftId } = req.validated!.params as { teamId: string; shiftId: string };
    await deleteShift(shards, { teamId, shiftId, actorUserId: req.auth!.userId });
    res.status(204).end();
  });

  return router;
}
