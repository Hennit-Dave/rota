// Seat limits, enforced on the server (AGENTS.md rule 3; the brief: "An owner on Starter cannot invite a sixth person").
// A seat is an active member, the Owner included. An invitation that is still usable (not accepted, revoked or expired) holds a seat for its person.
// A team that has not activated works within Starter's limits (ADR 0026); an activated team has the seats its subscription says.
import type { PrismaClient } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { PLANS } from './plans.js';

/** A transaction client, or the client itself: only raw queries are used. */
type Db = Pick<PrismaClient, '$queryRaw'>;

/** The seats a team may fill: its subscription's seats, or Starter's included seats when it has not activated. */
export async function seatLimitOf(db: Db, teamId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ seats: number }>>`SELECT seats FROM subscriptions WHERE team_id = ${teamId}::uuid`;
  return rows[0]?.seats ?? PLANS.starter.includedSeats;
}

export async function memberCountOf(db: Db, teamId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM memberships WHERE team_id = ${teamId}::uuid`;
  return Number(rows[0]?.n ?? 0);
}

async function pendingInvitationCountOf(db: Db, teamId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM invitations
    WHERE team_id = ${teamId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Run INSIDE a transaction that holds the team row lock (`SELECT ... FROM teams WHERE id = ... FOR UPDATE`), right after a usable invitation was
 * written: members plus usable invitations (the new one included) may not exceed the seat limit. Throws `seat_limit_reached`, which rolls the
 * invitation back. The lock is what makes two simultaneous invitations unable to both take the last seat.
 */
export async function assertSeatForInvitation(db: Db, teamId: string): Promise<void> {
  const limit = await seatLimitOf(db, teamId);
  const members = await memberCountOf(db, teamId);
  const pending = await pendingInvitationCountOf(db, teamId);
  if (members + pending > limit) throw new ApiError('seat_limit_reached', { reason: `members_${members}_pending_${pending}_limit_${limit}` });
}

/**
 * Run INSIDE the accept transaction (team row locked), after the invitation was consumed and before the membership is written: this is the
 * authoritative check. A new member needs a free seat, whatever the invitation said when it was made.
 */
export async function assertSeatForNewMember(db: Db, teamId: string): Promise<void> {
  const limit = await seatLimitOf(db, teamId);
  const members = await memberCountOf(db, teamId);
  if (members + 1 > limit) throw new ApiError('seat_limit_reached', { reason: `members_${members}_limit_${limit}` });
}
