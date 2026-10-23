import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '../auth/config.js';
import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { shardFor, type ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { can, type Role } from '../teams/permissions.js';
import { renderInviteEmail } from './emailTemplate.js';
import { issueInviteToken, parseInviteToken } from './tokens.js';

export type InvitableRole = 'manager' | 'staff';
export type EmailStatus = 'queued' | 'sent' | 'failed';

export interface InviteDeps {
  mail: { from: string; replyTo: string };
  /** Owns the https origin and the expiry; set from `config.invites`. */
  config: Pick<AuthConfig, 'invites' | 'transactionMaxWaitMs'>;
  /** Enqueues an ALREADY COMMITTED work row. Never throws (see `enqueueCommittedRow`). */
  enqueue: (prisma: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => Promise<void>;
  now?: () => Date;
}

export interface InvitationView {
  id: string;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
  emailStatus: EmailStatus;
  canResend: boolean;
  canRevoke: boolean;
}

const EMAIL_RUN_DELAY_MS = 2 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;

const asRole = (value: string): InvitableRole => (value === 'manager' ? 'manager' : 'staff');
const inviteAction = (role: InvitableRole): 'invite.manager' | 'invite.staff' => (role === 'manager' ? 'invite.manager' : 'invite.staff');
const nowOf = (deps: InviteDeps) => (deps.now ?? (() => new Date()))();

/** The link the email carries: https origin, then `/invite/<teamId>.<secret>` (ADR 0009 path-prefix form). */
function linkFor(deps: InviteDeps, token: string): string {
  return `${deps.config.invites.linkBaseUrl}/invite/${token}`;
}

/** What the pending list shows about the invitation's latest email (ADR 0016): the app displays this and decides nothing. */
export function emailStatusOf(workStatus: string | null, sentAt: Date | null): EmailStatus {
  if (workStatus === null) return 'queued';
  if (workStatus === 'pending' || workStatus === 'claimed') return 'queued';
  if (workStatus === 'done') return sentAt ? 'sent' : 'failed'; // done without a send: the job skipped a dead invitation
  return 'failed';
}

function view(
  row: { id: string; email: string; role: string; expiresAt: Date },
  emailStatus: EmailStatus,
  actorRole: Role,
): InvitationView {
  const role = asRole(row.role);
  const allowed = can(actorRole, inviteAction(role));
  return { id: row.id, email: row.email, role, expiresAt: row.expiresAt, emailStatus, canResend: allowed, canRevoke: allowed };
}

/** Writes the email work row for an invitation inside the caller's transaction, and points the invitation at it. */
async function writeEmailRow(
  tx: Pick<PrismaClient, 'workRow' | '$executeRaw'>,
  deps: InviteDeps,
  input: {
    invitationId: string;
    teamId: string;
    team: { name: string; timeZone: string };
    inviterName: string;
    to: string;
    role: InvitableRole;
    token: string;
    tokenHash: Buffer;
    expiresAt: Date;
    requestId: string | null;
    now: Date;
  },
): Promise<WorkRow> {
  const payload = renderInviteEmail({
    from: deps.mail.from,
    replyTo: deps.mail.replyTo,
    to: input.to,
    inviterName: input.inviterName,
    teamName: input.team.name,
    teamTimeZone: input.team.timeZone,
    role: input.role,
    link: linkFor(deps, input.token),
    expiresAt: input.expiresAt,
    invitationId: input.invitationId,
    tokenHashHex: input.tokenHash.toString('hex'),
  });
  const work = await tx.workRow.create({
    data: {
      kind: 'email',
      payload: payload as unknown as object,
      originRequestId: input.requestId,
      runAt: input.now,
      availableAt: new Date(input.now.getTime() + EMAIL_RUN_DELAY_MS),
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
    },
  });
  await tx.$executeRaw`UPDATE invitations SET email_work_row_id = ${work.id}::uuid, updated_at = NOW() WHERE id = ${input.invitationId}::uuid`;
  return work;
}

/**
 * Invite someone by email. The invitation and its email work row commit TOGETHER in one transaction on the team's shard (the foreign key
 * is same-database); only then is the job enqueued. Duplicates: the partial unique index decides, so two concurrent invites for one address
 * give exactly one winner. An EXPIRED unaccepted invitation for the same address is reused, rotated like a resend.
 */
export async function createInvitation(
  shards: Shards,
  deps: InviteDeps,
  input: {
    teamId: string;
    team: { name: string; timeZone: string };
    actor: { userId: string; role: Role };
    email: string;
    role: InvitableRole;
    requestId: string | null;
  },
): Promise<InvitationView> {
  const { teamId } = input;
  const shard = shardFor(teamId);
  const prisma = getShard(shards, teamId).primary;
  const identity = identityDb(shards);

  // Already on the team? (users are on shard A, memberships on the team's shard; no foreign key between them.)
  const existingUser = await identity.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existingUser) {
    const member = await prisma.membership.findUnique({ where: { teamId_userId: { teamId, userId: existingUser.id } }, select: { id: true } });
    if (member) throw new ApiError('already_member');
  }
  const inviter = await identity.user.findUnique({ where: { id: input.actor.userId }, select: { name: true } });
  if (!inviter) throw new ApiError('unauthenticated', { reason: 'user_missing' });

  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + deps.config.invites.expiryDays * day);
  const issued = issueInviteToken(teamId);
  const newId = randomUUID();

  const { invitationId, work } = await prisma.$transaction(
    async (tx) => {
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO invitations (id, team_id, email, role, token_hash, expires_at, invited_by_user_id)
        VALUES (${newId}::uuid, ${teamId}::uuid, ${input.email}, ${input.role}::team_role, ${issued.tokenHash}, ${expiresAt}, ${input.actor.userId}::uuid)
        ON CONFLICT (team_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL DO NOTHING
        RETURNING id`;
      let id: string = newId;
      if (inserted.length === 0) {
        const existing = await tx.$queryRaw<Array<{ id: string; expired: boolean }>>`
          SELECT id, expires_at <= NOW() AS expired FROM invitations
          WHERE team_id = ${teamId}::uuid AND email = ${input.email} AND accepted_at IS NULL AND revoked_at IS NULL
          FOR UPDATE`;
        const row = existing[0];
        if (!row || !row.expired) throw new ApiError('invite_pending');
        id = row.id;
        await tx.$executeRaw`
          UPDATE invitations
          SET role = ${input.role}::team_role, token_hash = ${issued.tokenHash}, expires_at = ${expiresAt},
              invited_by_user_id = ${input.actor.userId}::uuid, updated_at = NOW()
          WHERE id = ${id}::uuid`;
      }
      const work = await writeEmailRow(tx, deps, {
        invitationId: id,
        teamId,
        team: input.team,
        inviterName: inviter.name,
        to: input.email,
        role: input.role,
        token: issued.token,
        tokenHash: issued.tokenHash,
        expiresAt,
        requestId: input.requestId,
        now,
      });
      return { invitationId: id, work };
    },
    { maxWait: deps.config.transactionMaxWaitMs },
  );

  await deps.enqueue(prisma, work, shard);
  return view({ id: invitationId, email: input.email, role: input.role, expiresAt }, 'queued', input.actor.role);
}

/** Pending invitations (not accepted, not revoked, not expired) with the state of each one's latest email. Owner and Manager only (the route gates it). */
export async function listInvitations(shards: Shards, teamId: string, actorRole: Role): Promise<InvitationView[]> {
  const prisma = getShard(shards, teamId).primary;
  const rows = await prisma.$queryRaw<
    Array<{ id: string; email: string; role: string; expires_at: Date; wr_status: string | null; wr_sent_at: Date | null }>
  >`
    SELECT i.id, i.email, i.role::text AS role, i.expires_at, wr.status::text AS wr_status, wr.sent_at AS wr_sent_at
    FROM invitations i
    LEFT JOIN work_rows wr ON wr.id = i.email_work_row_id
    WHERE i.team_id = ${teamId}::uuid AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
    ORDER BY i.created_at ASC, i.id ASC`;
  return rows.map((r) => view({ id: r.id, email: r.email, role: r.role, expiresAt: r.expires_at }, emailStatusOf(r.wr_status, r.wr_sent_at), actorRole));
}

/**
 * Send again: the SAME invitation gets a new token and a new expiry, and a NEW email work row (a new token is a new logical email, jobs.md).
 * The old link stops working at once; an older email still queued is skipped by the email job. You may resend only what you could have created.
 */
export async function resendInvitation(
  shards: Shards,
  deps: InviteDeps,
  input: {
    teamId: string;
    team: { name: string; timeZone: string };
    invitationId: string;
    actor: { userId: string; role: Role };
    requestId: string | null;
  },
): Promise<InvitationView> {
  const { teamId } = input;
  const shard = shardFor(teamId);
  const prisma = getShard(shards, teamId).primary;
  const inviter = await identityDb(shards).user.findUnique({ where: { id: input.actor.userId }, select: { name: true } });
  if (!inviter) throw new ApiError('unauthenticated', { reason: 'user_missing' });

  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + deps.config.invites.expiryDays * day);

  const result = await prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ email: string; role: string }>>`
        SELECT email, role::text AS role FROM invitations
        WHERE id = ${input.invitationId}::uuid AND team_id = ${teamId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL
        FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new ApiError('not_found', { reason: 'invitation_not_pending' });
      const role = asRole(row.role);
      if (!can(input.actor.role, inviteAction(role))) throw new ApiError('forbidden', { reason: `role_${input.actor.role}_cannot_${inviteAction(role)}` });

      const issued = issueInviteToken(teamId);
      await tx.$executeRaw`
        UPDATE invitations
        SET token_hash = ${issued.tokenHash}, expires_at = ${expiresAt}, invited_by_user_id = ${input.actor.userId}::uuid, updated_at = NOW()
        WHERE id = ${input.invitationId}::uuid`;
      const work = await writeEmailRow(tx, deps, {
        invitationId: input.invitationId,
        teamId,
        team: input.team,
        inviterName: inviter.name,
        to: row.email,
        role,
        token: issued.token,
        tokenHash: issued.tokenHash,
        expiresAt,
        requestId: input.requestId,
        now,
      });
      return { work, email: row.email, role };
    },
    { maxWait: deps.config.transactionMaxWaitMs },
  );

  await deps.enqueue(prisma, result.work, shard);
  return view({ id: input.invitationId, email: result.email, role: result.role, expiresAt }, 'queued', input.actor.role);
}

/** Revoke: the link answers "unavailable" from now on. You may revoke only what you could have created. Gone or someone else's: 404. */
export async function revokeInvitation(
  shards: Shards,
  input: { teamId: string; invitationId: string; actor: { role: Role } },
): Promise<void> {
  const prisma = getShard(shards, input.teamId).primary;
  const row = await prisma.invitation.findFirst({
    where: { id: input.invitationId, teamId: input.teamId, acceptedAt: null, revokedAt: null },
    select: { role: true },
  });
  if (!row) throw new ApiError('not_found', { reason: 'invitation_not_pending' });
  const action = inviteAction(asRole(row.role));
  if (!can(input.actor.role, action)) throw new ApiError('forbidden', { reason: `role_${input.actor.role}_cannot_${action}` });

  const revoked = await prisma.$executeRaw`
    UPDATE invitations SET revoked_at = NOW(), updated_at = NOW()
    WHERE id = ${input.invitationId}::uuid AND team_id = ${input.teamId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL`;
  if (revoked === 0) throw new ApiError('not_found', { reason: 'invitation_not_pending' });
}

interface PendingInvitation {
  id: string;
  teamId: string;
  email: string;
  role: InvitableRole;
  invitedByUserId: string;
  teamName: string;
  teamTimeZone: string;
}

/**
 * Finds the invitation a token opens, only if it is still usable. Unknown token, malformed token, wrong team ID, expired, used and revoked
 * all give null, and callers answer them all with the same `invite_unavailable` (ADR 0015).
 */
async function findPending(shards: Shards, token: string): Promise<PendingInvitation | null> {
  const parsed = parseInviteToken(token);
  if (!parsed) return null;
  const prisma = getShard(shards, parsed.teamId).primary;
  const rows = await prisma.$queryRaw<
    Array<{ id: string; team_id: string; email: string; role: string; invited_by_user_id: string; team_name: string; time_zone: string }>
  >`
    SELECT i.id, i.team_id, i.email, i.role::text AS role, i.invited_by_user_id, t.name AS team_name, t.time_zone
    FROM invitations i JOIN teams t ON t.id = i.team_id
    WHERE i.team_id = ${parsed.teamId}::uuid AND i.token_hash = ${parsed.tokenHash}
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    teamId: r.team_id,
    email: r.email,
    role: asRole(r.role),
    invitedByUserId: r.invited_by_user_id,
    teamName: r.team_name,
    teamTimeZone: r.time_zone,
  };
}

/**
 * The success to repeat for the account that already accepted this exact token. Needs all of: the token is this invitation's current one, it was
 * accepted by THIS caller, it was not revoked, and the membership still exists (the answer reports the membership's role as it is now). Anyone else,
 * or a caller whose membership is gone, gets null and so the ordinary identical "unavailable".
 */
async function findAcceptedBy(
  shards: Shards,
  token: string,
  userId: string,
): Promise<{ team: { id: string; name: string; timeZone: string }; role: Role } | null> {
  const parsed = parseInviteToken(token);
  if (!parsed) return null;
  const prisma = getShard(shards, parsed.teamId).primary;
  const rows = await prisma.$queryRaw<Array<{ team_id: string; team_name: string; time_zone: string; role: string }>>`
    SELECT t.id AS team_id, t.name AS team_name, t.time_zone, m.role::text AS role
    FROM invitations i
    JOIN teams t ON t.id = i.team_id
    JOIN memberships m ON m.team_id = i.team_id AND m.user_id = i.accepted_by_user_id
    WHERE i.team_id = ${parsed.teamId}::uuid AND i.token_hash = ${parsed.tokenHash}
      AND i.accepted_by_user_id = ${userId}::uuid AND i.accepted_at IS NOT NULL AND i.revoked_at IS NULL`;
  const r = rows[0];
  if (!r) return null;
  return { team: { id: r.team_id, name: r.team_name, timeZone: r.time_zone }, role: r.role as Role };
}

export interface InvitePreview {
  team: { name: string };
  role: InvitableRole;
  inviter: { name: string; role: Role | null };
  email: string;
  /** The caller's own account against the invited address. 'none' when nobody is signed in. Decided here; the app only displays it. */
  account: 'matches' | 'different' | 'none';
}

/** Shows what the link is for. Consumes nothing, grants nothing: opening a link (or an email scanner fetching it) changes no row. */
export async function previewInvitation(shards: Shards, input: { token: string; viewerUserId: string | null }): Promise<InvitePreview> {
  const inv = await findPending(shards, input.token);
  if (!inv) throw new ApiError('invite_unavailable');
  const identity = identityDb(shards);
  const inviter = await identity.user.findUnique({ where: { id: inv.invitedByUserId }, select: { name: true } });
  const inviterMembership = await getShard(shards, inv.teamId).primary.membership.findUnique({
    where: { teamId_userId: { teamId: inv.teamId, userId: inv.invitedByUserId } },
    select: { role: true },
  });
  let account: InvitePreview['account'] = 'none';
  if (input.viewerUserId) {
    const viewer = await identity.user.findUnique({ where: { id: input.viewerUserId }, select: { email: true } });
    account = viewer && viewer.email === inv.email ? 'matches' : 'different';
  }
  return {
    team: { name: inv.teamName },
    role: inv.role,
    inviter: { name: inviter?.name ?? '', role: inviterMembership?.role ?? null },
    email: inv.email,
    account,
  };
}

/**
 * Accept (security.md "Invite ordering across shards", as amended by ADR 0015):
 *  1. validate on the team's shard without consuming; the signed-in account's email must equal the invited address (else invite_wrong_account);
 *  2. shard A: mark the address verified (NO password clearing, NO session revocation) and write the directory row FIRST (ADR 0013);
 *  3. the team's shard, ONE transaction: consume the invitation (conditional, so it is single use) and write the membership.
 * A failure after step 2 leaves an inert directory row and an unconsumed invitation; the retry completes it. The role comes from the invitation row.
 */
export async function acceptInvitation(
  shards: Shards,
  input: { token: string; userId: string },
): Promise<{ team: { id: string; name: string; timeZone: string }; role: Role }> {
  const inv = await findPending(shards, input.token);
  if (!inv) {
    // Used, expired, revoked, unknown: all "unavailable", EXCEPT to the one account that already accepted THIS token and is still a member:
    // that account gets the same success again (ADR 0015). It covers a lost response and two simultaneous requests from one person; it writes nothing.
    const replay = await findAcceptedBy(shards, input.token, input.userId);
    if (replay) return replay;
    throw new ApiError('invite_unavailable');
  }

  const identity = identityDb(shards);
  const user = await identity.user.findUnique({ where: { id: input.userId }, select: { email: true } });
  if (!user) throw new ApiError('unauthenticated', { reason: 'user_missing' });
  if (user.email !== inv.email) throw new ApiError('invite_wrong_account');

  await identity.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = ${input.userId}::uuid AND email_verified_at IS NULL`;
    await tx.userTeam.createMany({ data: [{ userId: input.userId, teamId: inv.teamId }], skipDuplicates: true });
  });

  const prisma = getShard(shards, inv.teamId).primary;
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.$executeRaw`
      UPDATE invitations SET accepted_at = NOW(), accepted_by_user_id = ${input.userId}::uuid, updated_at = NOW()
      WHERE id = ${inv.id}::uuid AND team_id = ${inv.teamId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`;
    if (consumed === 0) {
      // Lost a race. If the SAME person's other request just won, this one is the same success; anything else is "unavailable".
      const done = await tx.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM invitations i
        JOIN memberships m ON m.team_id = i.team_id AND m.user_id = i.accepted_by_user_id
        WHERE i.id = ${inv.id}::uuid AND i.accepted_by_user_id = ${input.userId}::uuid`;
      if (done.length === 0) throw new ApiError('invite_unavailable', { reason: 'lost_race' });
      return;
    }
    await tx.$executeRaw`
      INSERT INTO memberships (team_id, user_id, role)
      VALUES (${inv.teamId}::uuid, ${input.userId}::uuid, ${inv.role}::team_role)
      ON CONFLICT (team_id, user_id) DO NOTHING`;
  });

  return { team: { id: inv.teamId, name: inv.teamName, timeZone: inv.teamTimeZone }, role: inv.role };
}
