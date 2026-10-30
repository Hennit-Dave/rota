import { randomUUID } from 'node:crypto';
import { getShard, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { shardFor, type ShardId } from '../db/shard.js';
import type { Role } from './permissions.js';

export interface TeamView {
  id: string;
  name: string;
  timeZone: string;
  createdAt: Date;
}

export interface MemberView {
  userId: string;
  name: string;
  role: Role;
  joinedAt: Date;
}

/**
 * Creates a team. Order matters (ADR 0013, data.md exception):
 *  1. the directory row on shard A FIRST, then
 *  2. the team and its Owner membership in ONE transaction on the team's shard (a nested create is one transaction).
 * No transaction spans both shards. If step 2 fails the directory row is an inert orphan: reads verify against the team's
 * shard, so it grants nothing and is never listed. The directory may over-report, never under-report.
 */
export async function createTeam(
  shards: Shards,
  input: { userId: string; name: string; timeZone: string },
  onOrphan?: () => void,
): Promise<{ team: TeamView; role: Role }> {
  // randomUUID() is lowercase and hyphenated: the canonical form the shard function requires. Generated BEFORE any insert.
  const teamId = randomUUID();

  await identityDb(shards).userTeam.createMany({ data: [{ userId: input.userId, teamId }], skipDuplicates: true });

  try {
    const team = await getShard(shards, teamId).primary.team.create({
      data: {
        id: teamId,
        name: input.name,
        timeZone: input.timeZone,
        memberships: { create: { userId: input.userId, role: 'owner' } },
      },
    });
    return { team: toTeamView(team), role: 'owner' };
  } catch (err) {
    onOrphan?.(); // the directory row from step 1 now has no membership behind it
    throw err;
  }
}

/**
 * The caller's teams. One read on shard A (the directory), then one read per shard that actually appears, in parallel,
 * each verified against that shard's memberships (primary: a role change or removal must show at once). A directory row
 * with no membership behind it (an orphan) is dropped here.
 */
export async function listTeamsForUser(shards: Shards, userId: string): Promise<Array<{ team: TeamView; role: Role }>> {
  const directory = await identityDb(shards).userTeam.findMany({ where: { userId }, select: { teamId: true } });

  const byShard = new Map<ShardId, string[]>();
  for (const { teamId } of directory) {
    const shard = shardFor(teamId);
    byShard.set(shard, [...(byShard.get(shard) ?? []), teamId]);
  }

  const found = await Promise.all(
    [...byShard.entries()].map(([shard, teamIds]) =>
      shards[shard].primary.membership.findMany({
        where: { userId, teamId: { in: teamIds }, deactivatedAt: null },
        include: { team: true },
      }),
    ),
  );

  return found
    .flat()
    .map((m) => ({ team: toTeamView(m.team), role: m.role }))
    .sort((a, b) => a.team.createdAt.getTime() - b.team.createdAt.getTime() || a.team.id.localeCompare(b.team.id));
}

/**
 * A team's members with their names. Memberships come from the team's shard; the names live on shard A, fetched in ONE
 * batched query (WHERE id IN ...), never one per member. Emails are not selected: a Staff member listing the team must not
 * be able to read everyone's address.
 */
export async function listMembers(
  shards: Shards,
  teamId: string,
  onMissingUser?: (userId: string) => void,
): Promise<MemberView[]> {
  const memberships = await getShard(shards, teamId).primary.membership.findMany({
    where: { teamId, deactivatedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true, role: true, createdAt: true },
  });
  if (memberships.length === 0) return [];

  const users = await identityDb(shards).user.findMany({
    where: { id: { in: memberships.map((m) => m.userId) } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));

  const members: MemberView[] = [];
  for (const m of memberships) {
    const name = names.get(m.userId);
    if (name === undefined) {
      // No foreign key across databases (data.md), so a membership can outlive its user. Not shown; logged by the caller.
      onMissingUser?.(m.userId);
      continue;
    }
    members.push({ userId: m.userId, name, role: m.role, joinedAt: m.createdAt });
  }
  return members;
}

function toTeamView(t: { id: string; name: string; timeZone: string; createdAt: Date }): TeamView {
  return { id: t.id, name: t.name, timeZone: t.timeZone, createdAt: t.createdAt };
}
