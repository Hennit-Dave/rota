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
import { createTeamInvitationsRouter } from '../invites/routes.js';
import { createActivityRouter } from '../activity/routes.js';
import { createSwapsRouter } from '../swaps/routes.js';
import { createShiftsRouter } from '../shifts/routes.js';
import type { InviteDeps } from '../invites/service.js';
import { createRequireTeamRole } from './middleware.js';
import { can, invitableRoles } from './permissions.js';
import { createTeamBody, teamIdParams } from './schemas.js';
import { createTeam, listMembers, listTeamsForUser } from './service.js';

export interface TeamsDeps {
  shards: Shards;
  tokens: TokenService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  invites: InviteDeps;
}

const noStore: RequestHandler = (_req, res, next) => {
  // Team and member data is personal to the caller's team: never cacheable between the server and the app.
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** The team routes (mounted at /teams). The pipelines are the ones in security.md: user routes and team routes. */
export function createTeamsRouter(deps: TeamsDeps): Router {
  const { shards, tokens, limiter, logger, config, invites } = deps;
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });

  const router = Router();
  router.use(recordRouteBase);
  router.use(noStore);
  router.use(jsonBody());

  // POST /teams: user route. Zod, token, session, rate limit, handler. The creator becomes the Owner.
  router.post(
    '/',
    validateRequest({ body: createTeamBody }),
    requireAuth,
    rateLimit(limiter, logger, (req) => [
      { name: 'team_create_user', subject: req.auth!.userId, ...config.rateLimits.teamCreateUser },
    ]),
    async (req, res) => {
      const { name, timeZone } = req.validated!.body as { name: string; timeZone: string };
      const created = await createTeam(shards, { userId: req.auth!.userId, name, timeZone }, () =>
        // The directory row exists but the team does not (ADR 0013): an inert orphan, never listed. Logged for the cleanup sweep.
        logger.warn('team_create_orphan_directory_row', { requestId: String(res.locals.requestId ?? ''), userId: req.auth!.userId }),
      );
      res.status(201).json(created);
    },
  );

  // GET /teams: user route. The caller's own teams, from the directory, verified on each team's shard.
  router.get('/', validateRequest({}), requireAuth, async (req, res) => {
    const teams = await listTeamsForUser(shards, req.auth!.userId);
    res.json({ teams: teams.map(({ team, role }) => ({ id: team.id, name: team.name, timeZone: team.timeZone, role })) });
  });

  // GET /teams/:teamId: team route. Any member. Not a member, or no such team: the same 404.
  router.get('/:teamId', validateRequest({ params: teamIdParams }), requireAuth, requireTeamRole('team.view'), (req, res) => {
    const { team, role } = req.teamContext!;
    // What the caller may do here, decided from the permission table. The app shows what the server allows and computes nothing itself.
    res.json({
      team,
      role,
      invitableRoles: invitableRoles(role),
      canManageInvitations: can(role, 'invitations.list'),
      // Whether to offer "Create an invite link" (ADR 0025): the server's answer from the permission table; the route checks again.
      canCreateInviteLink: can(role, 'invite.staff'),
      canEditShifts: can(role, 'shifts.edit'),
    });
  });

  // GET /teams/:teamId/members: team route. Any member. Names come from shard A in one batched query.
  router.get(
    '/:teamId/members',
    validateRequest({ params: teamIdParams }),
    requireAuth,
    requireTeamRole('members.list'),
    async (req, res) => {
      const { teamId } = req.validated!.params as { teamId: string };
      const members = await listMembers(shards, teamId, () =>
        logger.warn('membership_without_user', { requestId: String(res.locals.requestId ?? '') }),
      );
      res.json({ members });
    },
  );

  router.use('/:teamId/invitations', createTeamInvitationsRouter({ shards, tokens, limiter, logger, config, invites }));
  // Shifts (ADR 0021). They carry the router's body parser, log base and no-store through `router.use` above.
  router.use('/:teamId/shifts', createShiftsRouter({ shards, tokens }));
  router.use('/:teamId/activity', createActivityRouter({ shards, tokens, limiter, logger, config }));
  router.use('/:teamId/swaps', createSwapsRouter({ shards, tokens, limiter, logger, config }));

  return router;
}
