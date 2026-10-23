import type { RequestHandler } from 'express';
import { getShard, type Shards } from '../db/clients.js';
import { ApiError } from '../http/errors.js';
import { can, type PermissionAction, type Role } from './permissions.js';
import type { TeamView } from './service.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireTeamRole: the caller's team and role, read from the team shard's primary on this request. */
    teamContext?: { team: TeamView; role: Role };
  }
}

/**
 * Team-route pipeline step (security.md): after the access token and session check, load the caller's membership from the
 * TEAM'S shard primary (roles are primary-required reads, data.md) and check the permission table.
 *
 *  - No membership: 404. A team the caller is not in looks exactly like a team that does not exist, so its existence is not
 *    revealed. The team comes from the validated route parameter, never from the body or the token.
 *  - A membership whose role does not allow the action: 403.
 */
export function createRequireTeamRole(deps: { shards: Shards }): (action: PermissionAction) => RequestHandler {
  return (action) => async (req, _res, next) => {
    const { teamId } = req.validated!.params as { teamId: string };
    const userId = req.auth!.userId;

    const membership = await getShard(deps.shards, teamId).primary.membership.findUnique({
      where: { teamId_userId: { teamId, userId } },
      include: { team: true },
    });
    if (!membership) {
      next(new ApiError('not_found', { reason: 'not_a_member' }));
      return;
    }
    if (!can(membership.role, action)) {
      next(new ApiError('forbidden', { reason: `role_${membership.role}_cannot_${action}` }));
      return;
    }

    const { team } = membership;
    req.teamContext = {
      team: { id: team.id, name: team.name, timeZone: team.timeZone, createdAt: team.createdAt },
      role: membership.role,
    };
    next();
  };
}
