import { Router, type RequestHandler } from 'express';
import type { AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { jsonBody } from '../http/json.js';
import { recordRouteBase, type Logger } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { clientIp, rateLimit, type RateLimiter } from '../ratelimit/limiter.js';
import { createRequireTeamRole } from '../teams/middleware.js';
import { createInviteSchemas } from './schemas.js';
import {
  acceptInvitation,
  createInvitation,
  createInviteLink,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
  type InvitableRole,
  type InviteDeps,
} from './service.js';

export interface InvitesRouteDeps {
  shards: Shards;
  tokens: TokenService;
  limiter: RateLimiter;
  logger: Logger;
  config: AuthConfig;
  invites: InviteDeps;
}

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Seconds from `now` to the next 00:00 UTC. Resend's daily quota is a UTC calendar day, so the app-wide cap resets at the same moment. */
export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

const requestIdOf = (res: { locals: Record<string, unknown> }) => String(res.locals.requestId ?? '') || null;

/**
 * The team-scoped invitation routes, mounted at /teams/:teamId/invitations (mergeParams). Pipeline (security.md, Team route), with ONE deliberate
 * refinement (ADR 0015): the limits keyed by the TEAM or by the whole app run after the membership and role check. A limit keyed by a team
 * the caller has not proven to belong to would let any signed-in user burn another team's daily budget, or the app-wide cap, by hitting its URL.
 * The per-user limit still runs first.
 */
export function createTeamInvitationsRouter(deps: InvitesRouteDeps): Router {
  const { shards, tokens, limiter, logger, config, invites } = deps;
  const schemas = createInviteSchemas(config);
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });
  const now = invites.now ?? (() => new Date());

  const router = Router({ mergeParams: true });

  const userSendLimit = rateLimit(limiter, logger, (req) => [
    { name: 'invite_send_user', subject: req.auth!.userId, ...config.rateLimits.inviteSendUser },
  ]);
  const teamSendLimit = rateLimit(limiter, logger, (req) => [
    { name: 'invite_send_team', subject: (req.validated!.params as { teamId: string }).teamId, ...config.rateLimits.inviteSendTeam },
  ]);
  // Counted only for requests that already passed the per-user, membership and team checks, so a blocked or unauthorised caller never uses it up.
  const globalSendCap = rateLimit(limiter, logger, () => [
    { name: 'invite_send_global', subject: 'global', max: config.invites.globalDailyCap, windowSeconds: secondsUntilUtcMidnight(now()) },
  ]);

  // Invite links (ADR 0025) send no email, so they have their own limits and never touch the app-wide email cap.
  const userLinkLimit = rateLimit(limiter, logger, (req) => [
    { name: 'invite_link_user', subject: req.auth!.userId, ...config.rateLimits.inviteLinkUser },
  ]);
  const teamLinkLimit = rateLimit(limiter, logger, (req) => [
    { name: 'invite_link_team', subject: (req.validated!.params as { teamId: string }).teamId, ...config.rateLimits.inviteLinkTeam },
  ]);

  // POST /teams/:teamId/invitations/links  (no body: a link is always Staff, so there is no role to choose)
  router.post(
    '/links',
    validateRequest({ params: schemas.teamParams }),
    requireAuth,
    userLinkLimit,
    requireTeamRole('invite.staff'), // Owner and Manager, from the permission table
    teamLinkLimit,
    async (req, res) => {
      const { teamId } = req.validated!.params as { teamId: string };
      const ctx = req.teamContext!;
      const made = await createInviteLink(shards, invites, { teamId, actor: { userId: req.auth!.userId, role: ctx.role } });
      // The link is in this answer and nowhere else, ever: only its hash is stored.
      res.status(201).json(made);
    },
  );

  // POST /teams/:teamId/invitations
  router.post(
    '/',
    validateRequest({ params: schemas.teamParams, body: schemas.create }),
    requireAuth,
    userSendLimit,
    requireTeamRole((req) => ((req.validated!.body as { role: InvitableRole }).role === 'manager' ? 'invite.manager' : 'invite.staff')),
    teamSendLimit,
    globalSendCap,
    async (req, res) => {
      const { teamId } = req.validated!.params as { teamId: string };
      const { email, role } = req.validated!.body as { email: string; role: InvitableRole };
      const ctx = req.teamContext!;
      const invitation = await createInvitation(shards, invites, {
        teamId,
        team: { name: ctx.team.name, timeZone: ctx.team.timeZone },
        actor: { userId: req.auth!.userId, role: ctx.role },
        email,
        role,
        requestId: requestIdOf(res),
      });
      res.status(201).json({ invitation });
    },
  );

  // GET /teams/:teamId/invitations
  router.get('/', validateRequest({ params: schemas.teamParams }), requireAuth, requireTeamRole('invitations.list'), async (req, res) => {
    const { teamId } = req.validated!.params as { teamId: string };
    res.json({ invitations: await listInvitations(shards, teamId, req.teamContext!.role) });
  });

  // POST /teams/:teamId/invitations/:invitationId/resend
  router.post(
    '/:invitationId/resend',
    validateRequest({ params: schemas.invitationParams }),
    requireAuth,
    userSendLimit,
    requireTeamRole('invite.staff'), // the gate: Owner and Manager. The invitation's own role is checked in the service.
    teamSendLimit,
    globalSendCap,
    async (req, res) => {
      const { teamId, invitationId } = req.validated!.params as { teamId: string; invitationId: string };
      const ctx = req.teamContext!;
      const invitation = await resendInvitation(shards, invites, {
        teamId,
        team: { name: ctx.team.name, timeZone: ctx.team.timeZone },
        invitationId,
        actor: { userId: req.auth!.userId, role: ctx.role },
        requestId: requestIdOf(res),
      });
      res.json({ invitation });
    },
  );

  // DELETE /teams/:teamId/invitations/:invitationId  (revoke)
  router.delete(
    '/:invitationId',
    validateRequest({ params: schemas.invitationParams }),
    requireAuth,
    requireTeamRole('invite.staff'),
    async (req, res) => {
      const { teamId, invitationId } = req.validated!.params as { teamId: string; invitationId: string };
      await revokeInvitation(shards, { teamId, invitationId, actor: { role: req.teamContext!.role } });
      res.status(204).end();
    },
  );

  return router;
}

/**
 * The routes that do not start from a team the caller belongs to (mounted at /invitations): the link's preview, and accepting. The caller holds
 * a token, not (yet) a membership.
 */
export function createInvitationsRouter(deps: InvitesRouteDeps): Router {
  const { shards, tokens, limiter, logger, config } = deps;
  const schemas = createInviteSchemas(config);
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });

  /** Uses the caller's session if there is a valid one; a missing, expired or bad token is simply "nobody signed in". */
  const optionalAuth: RequestHandler = (req, res, next) => {
    Promise.resolve(requireAuth(req, res, () => next())).catch(next);
  };

  const router = Router();
  router.use(recordRouteBase);
  router.use(noStore);
  router.use(jsonBody());

  // POST /invitations/preview: public. Zod, IP rate limit, handler. A POST so the token never sits in an access log; consumes nothing.
  router.post(
    '/preview',
    validateRequest({ body: schemas.token }),
    rateLimit(limiter, logger, (req) => [{ name: 'invite_preview_ip', subject: clientIp(req), ...config.rateLimits.invitePreviewIp }]),
    optionalAuth,
    async (req, res) => {
      const { token } = req.validated!.body as { token: string };
      res.json(await previewInvitation(shards, { token, viewerUserId: req.auth?.userId ?? null }));
    },
  );

  // POST /invitations/accept: invite accept. Zod, IP rate limit, authenticated identity, user rate limit, redeem.
  router.post(
    '/accept',
    validateRequest({ body: schemas.token }),
    rateLimit(limiter, logger, (req) => [{ name: 'invite_accept_ip', subject: clientIp(req), ...config.rateLimits.inviteAcceptIp }]),
    requireAuth,
    rateLimit(limiter, logger, (req) => [{ name: 'invite_accept_user', subject: req.auth!.userId, ...config.rateLimits.inviteAcceptUser }]),
    async (req, res) => {
      const { token } = req.validated!.body as { token: string };
      res.json(await acceptInvitation(shards, { token, userId: req.auth!.userId }));
    },
  );

  return router;
}
