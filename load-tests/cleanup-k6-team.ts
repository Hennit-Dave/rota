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

  // Cascades: memberships, activity, invitations, shifts, swap_requests (all onDelete: Cascade on Team).
  const team = await shards[shard].primary.team.deleteMany({ where: { id: teamId } });
  console.log(`deleted team ${teamId} on shard ${shard}: ${team.count}`);

  // Cascades: credentials, user_teams, refresh_token_families -> refresh_tokens (all onDelete: Cascade on User).
  const users = await identity.user.deleteMany({ where: { id: { in: tokens.map((t) => t.userId) } } });
  console.log(`deleted users: ${users.count}`);

  const remainingTeam = await shards[shard].primary.team.count({ where: { id: teamId } });
  const remainingUsers = await identity.user.count({ where: { id: { in: tokens.map((t) => t.userId) } } });
  console.log(`verified empty: team=${remainingTeam} users=${remainingUsers}`);

  await closeShards(shards);

  rmSync(TOKENS_FILE, { force: true });
  console.log('removed .k6-tokens.json');
}

await main();
