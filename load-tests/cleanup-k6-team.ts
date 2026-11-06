// Deletes everything seed-k6-team.ts wrote to the real shards, and the local token file. Reads the
// team ID and shard from .k6-tokens.json rather than taking them as arguments, so cleanup can never
// target the wrong team by a typo.
//
//   cd server && npx tsx --env-file-if-exists=../.env ../load-tests/cleanup-k6-team.ts
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { createShards, closeShards } from '../server/src/db/clients.js';
import { identityDb } from '../server/src/db/identity.js';
import type { ShardId } from '../server/src/db/shard.js';

const TOKENS_FILE = new URL('.k6-tokens.json', import.meta.url);

async function main() {
  if (!existsSync(TOKENS_FILE)) {
    console.log('no .k6-tokens.json found - nothing to clean up (already done, or never seeded)');
    return;
  }
  const { teamId, shard, tokens } = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) as {
    teamId: string;
    shard: ShardId;
    tokens: Array<{ userId: string }>;
  };

  const shards = createShards({ primaryMax: 5 });
  const identity = identityDb(shards);
  const userIds = tokens.map((t) => t.userId);

  const familiesBefore = await identity.refreshTokenFamily.count({ where: { userId: { in: userIds } } });
  console.log(`refresh_token_families before cleanup: ${familiesBefore}`);

  // Cascades: memberships, activity, invitations, shifts, swap_requests (all onDelete: Cascade on Team).
  const team = await shards[shard].primary.team.deleteMany({ where: { id: teamId } });
  console.log(`deleted team ${teamId} on shard ${shard}: ${team.count}`);

  // Deleting the user cascades credentials, user_teams, and refresh_token_families -> refresh_tokens
  // (all onDelete: Cascade on User in schema.prisma) - a database-level FK cascade, not application
  // code, so the 200 seeded sessions are revoked by construction, not by remembering to revoke them.
  const users = await identity.user.deleteMany({ where: { id: { in: userIds } } });
  console.log(`deleted users: ${users.count}`);

  const remainingTeam = await shards[shard].primary.team.count({ where: { id: teamId } });
  const remainingUsers = await identity.user.count({ where: { id: { in: userIds } } });
  const remainingFamilies = await identity.refreshTokenFamily.count({ where: { userId: { in: userIds } } });
  console.log(`verified empty: team=${remainingTeam} users=${remainingUsers} refresh_token_families=${remainingFamilies}`);

  await closeShards(shards);

  rmSync(TOKENS_FILE, { force: true });
  console.log('removed .k6-tokens.json');
}

await main();
