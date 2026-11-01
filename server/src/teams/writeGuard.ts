import type { RequestHandler } from 'express';
import type { Shards } from '../db/clients.js';
import { ApiError } from '../http/errors.js';
import { isTeamReadOnly } from '../billing/renewalState.js';

/**
 * THE restricted-access guard (ADR 0031; money.md: after the grace period "nobody creates or edits shifts"; Dave widened it to every non-billing write). One step, put on
 * every team route that WRITES and is not billing: shifts, swaps and invitations. It refuses with 403 `team_read_only` while the team's current renewal has failed and
 * its grace period has ended, and lets the request through the moment the payment is confirmed (it reads the database every time; nothing is cached).
 *
 * It sits AFTER the membership check (`requireTeamRole`), never before: a stranger must still get the same 404 as for a team that does not exist, so the guard can
 * never reveal that a team exists or that it is overdue. Reads, sign-in, account recovery and the Owner's billing routes do not use it, so they keep working.
 *
 * The handler is named `requireWritable` on purpose: a test walks every team router and fails if a route that writes lacks a step with that name, so a new write route
 * cannot forget the guard.
 */
export function createRequireWritable(deps: { shards: Shards }): RequestHandler {
  return async function requireWritable(req, _res, next) {
    const { teamId } = req.validated!.params as { teamId: string };
    if (await isTeamReadOnly(deps.shards, teamId)) {
      next(new ApiError('team_read_only', { reason: 'payment_overdue_grace_ended' }));
      return;
    }
    next();
  };
}
