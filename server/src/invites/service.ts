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

export type InvitationKind = 'email' | 'link';

export interface InvitationView {
  id: string;
  /** `email`: tied to one address. `link`: anyone holding the link may use it once (ADR 0025). */
  kind: InvitationKind;
  /** The invited address; null for an invite link, which is not tied to anyone. */
  email: string | null;
  role: InvitableRole;
  expiresAt: Date;
  /** The latest email's state; null for a link, which sends none. */
  emailStatus: EmailStatus | null;
  canResend: boolean;
  canRevoke: boolean;
}

const EMAIL_RUN_DELAY_MS = 2 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;

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
  row: { id: string; email: string | null; role: string; expiresAt: Date; kind?: InvitationKind },
  emailStatus: EmailStatus | null,
  actorRole: Role,
): InvitationView {
  const role = asRole(row.role);
  const kind = row.kind ?? 'email';
  const allowed = can(actorRole, inviteAction(role));
  // A link has no address to send to again: there is no "resend". To replace one, revoke it and make a new one.
  return { id: row.id, kind, email: row.email, role, expiresAt: row.expiresAt, emailStatus, canResend: allowed && kind === 'email', canRevoke: allowed };
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

/**
 * Make an invite link (ADR 0025, issue #37): a Staff invitation not tied to an email address, for whoever holds the link, once. One row on the team's
 * shard, no email, no work row, nothing enqueued. The secret exists only in the returned link: only its hash is stored, so the link is shown ONCE and a
 * lost one is revoked and made again. At most `linkMaxPending` links may wait per team; the team row is locked while the count and the insert run, so two
 * simultaneous requests cannot both take the last place. Who may make one (Owner and Manager) is checked by the route against the permission table.
 */
export async function createInviteLink(
  shards: Shards,
  deps: InviteDeps,
  input: { teamId: string; actor: { userId: string; role: Role } },
): Promise<{ invitation: InvitationView; link: string }> {
  const { teamId } = input;
  const prisma = getShard(shards, teamId).primary;
  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + deps.config.invites.linkExpiryHours * hour);
  const issued = issueInviteToken(teamId);
  const id = randomUUID();
  const cap = deps.config.invites.linkMaxPending;

  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
      const pending = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM invitations
        WHERE team_id = ${teamId}::uuid AND kind = 'link' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`;
      if (Number(pending[0]?.n ?? 0) >= cap) throw new ApiError('invite_link_limit');
      await tx.$executeRaw`
        INSERT INTO invitations (id, team_id, kind, email, role, token_hash, expires_at, invited_by_user_id)
        VALUES (${id}::uuid, ${teamId}::uuid, 'link'::invitation_kind, NULL, 'staff'::team_role, ${issued.tokenHash}, ${expiresAt}, ${input.actor.userId}::uuid)`;
    },
    { maxWait: deps.config.transactionMaxWaitMs },
  );

  return { invitation: view({ id, kind: 'link', email: null, role: 'staff', expiresAt }, null, input.actor.role), link: linkFor(deps, issued.token) };
}

/** Pending invitations (not accepted, not revoked, not expired) with the state of each one's latest email. Owner and Manager only (the route gates it). */
export async function listInvitations(shards: Shards, teamId: string, actorRole: Role): Promise<InvitationView[]> {
  const prisma = getShard(shards, teamId).primary;
  const rows = await prisma.$queryRaw<
    Array<{ id: string; kind: InvitationKind; email: string | null; role: string; expires_at: Date; wr_status: string | null; wr_sent_at: Date | null }>
  >`
    SELECT i.id, i.kind::text AS kind, i.email, i.role::text AS role, i.expires_at, wr.status::text AS wr_status, wr.sent_at AS wr_sent_at
    FROM invitations i
    LEFT JOIN work_rows wr ON wr.id = i.email_work_row_id
    WHERE i.team_id = ${teamId}::uuid AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
    ORDER BY i.created_at ASC, i.id ASC`;
  return rows.map((r) =>
    view({ id: r.id, kind: r.kind, email: r.email, role: r.role, expiresAt: r.expires_at }, r.kind === 'link' ? null : emailStatusOf(r.wr_status, r.wr_sent_at), actorRole),
  );
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
      const rows = await tx.$queryRaw<Array<{ email: string | null; role: string }>>`
        SELECT email, role::text AS role FROM invitations
        WHERE id = ${input.invitationId}::uuid AND team_id = ${teamId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL
        FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new ApiError('not_found', { reason: 'invitation_not_pending' });
      // An invite link has no address, so there is nothing to send again: it answers like an invitation that is not there (ADR 0025).
      if (row.email === null) throw new ApiError('not_found', { reason: 'invite_link_has_no_email' });
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
  kind: InvitationKind;
  /** The invited address; null for an invite link. */
  email: string | null;
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
    Array<{ id: string; team_id: string; kind: InvitationKind; email: string | null; role: string; invited_by_user_id: string; team_name: string; time_zone: string }>
  >`
    SELECT i.id, i.team_id, i.kind::text AS kind, i.email, i.role::text AS role, i.invited_by_user_id, t.name AS team_name, t.time_zone
    FROM invitations i JOIN teams t ON t.id = i.team_id
    WHERE i.team_id = ${parsed.teamId}::uuid AND i.token_hash = ${parsed.tokenHash}
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    teamId: r.team_id,
    kind: r.kind,
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

/** The caller's own membership of a team, if they have one: the team and the role they ALREADY hold (an invitation never changes it). */
async function membershipOf(
  shards: Shards,
  teamId: string,
  userId: string,
): Promise<{ team: { id: string; name: string; timeZone: string }; role: Role } | null> {
  const rows = await getShard(shards, teamId).primary.$queryRaw<Array<{ team_id: string; team_name: string; time_zone: string; role: string }>>`
    SELECT t.id AS team_id, t.name AS team_name, t.time_zone, m.role::text AS role
    FROM memberships m JOIN teams t ON t.id = m.team_id
    WHERE m.team_id = ${teamId}::uuid AND m.user_id = ${userId}::uuid`;
  const r = rows[0];
  return r ? { team: { id: r.team_id, name: r.team_name, timeZone: r.time_zone }, role: r.role as Role } : null;
}

export interface PendingInvitePreview {
  status: 'pending';
  /** `link`: not tied to an address; any signed-in account may accept it once (ADR 0025). */
  kind: InvitationKind;
  team: { name: string };
  role: InvitableRole;
  inviter: { name: string; role: Role | null };
  /** The invited address; null for an invite link. */
  email: string | null;
  /**
   * The caller's own account against the invited address. 'none' when nobody is signed in; 'open' for a link and a signed-in caller (there is no address to
   * compare: the link is the credential). Decided here; the app only displays it.
   */
  account: 'matches' | 'different' | 'none' | 'open';
}

/** The caller already accepted this exact token and is still a member (ADR 0017): the same team and role the accept answer gives, so the app can go there. */
export interface AlreadyMemberPreview {
  status: 'already_member';
  team: { id: string; name: string; timeZone: string };
  role: Role;
}

export type InvitePreview = PendingInvitePreview | AlreadyMemberPreview;

/**
 * Shows what the link is for. Consumes nothing, grants nothing: opening a link (or an email scanner fetching it) changes no row.
 * Mirrors accept's idempotency (ADR 0017): the one account that already accepted this exact token and still has the membership gets
 * `already_member`, so someone who taps their email link again is sent to their team, not told "no team access was granted".
 * Everyone else, signed in or not, keeps the identical `invite_unavailable`.
 */
export async function previewInvitation(shards: Shards, input: { token: string; viewerUserId: string | null }): Promise<InvitePreview> {
  const inv = await findPending(shards, input.token);
  if (!inv) {
    const replay = input.viewerUserId ? await findAcceptedBy(shards, input.token, input.viewerUserId) : null;
    if (replay) return { status: 'already_member', ...replay };
    throw new ApiError('invite_unavailable');
  }
  // Someone already on the team who opens a link is sent to their team: the link is neither shown as theirs to use nor consumed (ADR 0025).
  if (inv.kind === 'link' && input.viewerUserId) {
    const existing = await membershipOf(shards, inv.teamId, input.viewerUserId);
    if (existing) return { status: 'already_member', ...existing };
  }
  const identity = identityDb(shards);
  const inviter = await identity.user.findUnique({ where: { id: inv.invitedByUserId }, select: { name: true } });
  const inviterMembership = await getShard(shards, inv.teamId).primary.membership.findUnique({
    where: { teamId_userId: { teamId: inv.teamId, userId: inv.invitedByUserId } },
    select: { role: true },
  });
  let account: PendingInvitePreview['account'] = 'none';
  if (input.viewerUserId) {
    if (inv.kind === 'link') {
      account = 'open';
    } else {
      const viewer = await identity.user.findUnique({ where: { id: input.viewerUserId }, select: { email: true } });
      account = viewer && viewer.email === inv.email ? 'matches' : 'different';
    }
  }
  return {
    status: 'pending',
    kind: inv.kind,
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

  // A link never touches an existing member: nothing is consumed and the role they hold stays as it is (ADR 0025).
  if (inv.kind === 'link') {
    const existing = await membershipOf(shards, inv.teamId, input.userId);
    if (existing) return existing;
  }

  const identity = identityDb(shards);
  const user = await identity.user.findUnique({ where: { id: input.userId }, select: { email: true } });
  if (!user) throw new ApiError('unauthenticated', { reason: 'user_missing' });
  // An email invitation is for one address. A link has none: whoever holds it may use it once, so there is nothing to compare.
  if (inv.email !== null && user.email !== inv.email) throw new ApiError('invite_wrong_account');

  await identity.$transaction(async (tx) => {
    // Redeeming an EMAIL invitation proves control of the address (security.md). A link proves nothing about it, so it verifies nothing.
    if (inv.kind === 'email') {
      await tx.$executeRaw`UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = ${input.userId}::uuid AND email_verified_at IS NULL`;
    }
    await tx.userTeam.createMany({ data: [{ userId: input.userId, teamId: inv.teamId }], skipDuplicates: true });
  });

  const prisma = getShard(shards, inv.teamId).primary;
  try {
    await consumeAndJoin(prisma, inv, input.userId);
  } catch (error) {
    // Several people may hold one link, so losing the race for it is ordinary: take back the directory row written above if the caller is NOT a member
    // (best effort; the orphan sweep, issue #33, covers a failure here), so a stranger's directory is not left pointing at a team.
    if (inv.kind === 'link' && error instanceof ApiError && error.code === 'invite_unavailable') await dropUnusedDirectoryRow(shards, inv.teamId, input.userId);
    throw error;
  }
  return { team: { id: inv.teamId, name: inv.teamName, timeZone: inv.teamTimeZone }, role: inv.role };
}

async function dropUnusedDirectoryRow(shards: Shards, teamId: string, userId: string): Promise<void> {
  try {
    if (await membershipOf(shards, teamId, userId)) return;
    await identityDb(shards).userTeam.deleteMany({ where: { userId, teamId } });
  } catch {
    // Ignored on purpose: an extra directory row is only a hint that over-reports (ADR 0013).
  }
}

/** Step 3: ONE transaction on the team's shard that consumes the invitation (conditional, so it is single use) and writes the membership. */
async function consumeAndJoin(prisma: PrismaClient, inv: PendingInvitation, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.$executeRaw`
      UPDATE invitations SET accepted_at = NOW(), accepted_by_user_id = ${userId}::uuid, updated_at = NOW()
      WHERE id = ${inv.id}::uuid AND team_id = ${inv.teamId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`;
    if (consumed === 0) {
      // Lost a race. If the SAME person's other request just won, this one is the same success; anything else is "unavailable".
      const done = await tx.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM invitations i
        JOIN memberships m ON m.team_id = i.team_id AND m.user_id = i.accepted_by_user_id
        WHERE i.id = ${inv.id}::uuid AND i.accepted_by_user_id = ${userId}::uuid`;
      if (done.length === 0) throw new ApiError('invite_unavailable', { reason: 'lost_race' });
      return;
    }
    await tx.$executeRaw`
      INSERT INTO memberships (team_id, user_id, role)
      VALUES (${inv.teamId}::uuid, ${userId}::uuid, ${inv.role}::team_role)
      ON CONFLICT (team_id, user_id) DO NOTHING`;
  });
}
