// Seeds the real shards for the k6 load test (load-test skill, Dave's additions 2026-11-06):
// - one team, "k6 load test", on whichever shard its random ID lands on
// - 200 member users, no passwords: each gets a session minted directly through the server's own
//   session/token code (createSession + TokenService.sign), the same way a real login would produce
//   one, WITHOUT ever calling POST /auth/login - so 200 logins never touch the per-IP login limiter.
// - 10,000 activity rows for that team, same shape as server/src/db/feed-proof.ts's proof data, so
//   cursor paging is real, not a handful of rows that all fit on one page.
//
// Signs with K6_DEPLOY_AUTH_JWT_SECRET, never AUTH_JWT_SECRET: the deployed rota-api verifies tokens
// against its OWN secret, which is deliberately different from local dev's (Dave, 2026-11-06, found
// the hard way - a first run signed locally and every request came back 401). K6_DEPLOY_AUTH_JWT_SECRET
// is the deployed value, pasted into root .env by Dave for this run only, never printed here, and
// never synced into AUTH_JWT_SECRET itself. This script refuses to run without it - it never falls
// back to signing with the local secret against the real shards.
//
// Real shards. Nothing else on them is touched. Run from server/ so tsx resolves its own node_modules:
//   cd server && npx tsx --env-file-if-exists=../.env ../load-tests/seed-k6-team.ts
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createShards, closeShards } from '../server/src/db/clients.js';
import { identityDb } from '../server/src/db/identity.js';
import { shardFor } from '../server/src/db/shard.js';
import { loadAuthConfig, loadJwtSecret } from '../server/src/auth/config.js';
import { createTokenService } from '../server/src/auth/tokens.js';
import { createSession } from '../server/src/auth/sessions.js';

const TEAM_NAME = 'k6 load test';
const USER_COUNT = 200;
const ACTIVITY_ROWS = 10_000;
const OUTPUT_FILE = new URL('.k6-tokens.json', import.meta.url);

function loadDeploySecret(): Uint8Array {
  const raw = process.env.K6_DEPLOY_AUTH_JWT_SECRET;
  if (!raw) {
    throw new Error(
      'K6_DEPLOY_AUTH_JWT_SECRET is not set. This script seeds the REAL shards and mints tokens the ' +
        'DEPLOYED API must verify, so it refuses to fall back to the local AUTH_JWT_SECRET - they are ' +
        'deliberately different. Paste the deployed value into root .env as K6_DEPLOY_AUTH_JWT_SECRET ' +
        'yourself (never AUTH_JWT_SECRET, which stays local-only).',
    );
  }
  // Reuses loadJwtSecret's own base64/length validation (RFC 7518 3.2) rather than re-implementing it,
  // just pointed at the deploy secret instead of AUTH_JWT_SECRET.
  return loadJwtSecret({ AUTH_JWT_SECRET: raw });
}

async function main() {
  const shards = createShards({ primaryMax: 5 });
  const authConfig = loadAuthConfig();
  const tokens = createTokenService({ secret: loadDeploySecret(), config: authConfig });
  const identity = identityDb(shards);

  console.log(`feed rate limit actually configured: ${authConfig.rateLimits.feedUser.max} requests / ${authConfig.rateLimits.feedUser.windowSeconds}s per user`);
  console.log(`access token lifetime: ${authConfig.accessTokenMinutes} minutes - run k6 soon after seeding`);

  const teamId = randomUUID();
  const shard = shardFor(teamId);
  const teamPrisma = shards[shard].primary;
  console.log(`team ${teamId} on shard ${shard}`);

  await teamPrisma.team.create({ data: { id: teamId, name: TEAM_NAME, timeZone: 'Europe/London' } });

  const tokensOut: Array<{ userId: string; accessToken: string }> = [];
  for (let n = 1; n <= USER_COUNT; n++) {
    const user = await identity.user.create({
      data: { email: `k6-load-test+${String(n).padStart(3, '0')}@davebuilds.design`, name: `k6 user ${n}` },
    });
    await teamPrisma.membership.create({
      data: { teamId, userId: user.id, role: n === 1 ? 'owner' : 'staff' },
    });
    const session = await createSession(identity, { userId: user.id, config: authConfig, now: new Date() });
    const signed = await tokens.sign({ userId: user.id, familyId: session.familyId });
    tokensOut.push({ userId: user.id, accessToken: signed.token });
  }
  console.log(`${tokensOut.length} users + sessions created (1 owner, ${tokensOut.length - 1} staff)`);

  // Same shape as feed-proof.ts: one row every 7 minutes, two rows per timestamp so half of all rows
  // tie on created_at (exercising the `id` tiebreak), no FK on actor_user_id so this needs no real actors.
  await teamPrisma.$executeRaw`
    INSERT INTO activity (id, team_id, created_at, actor_user_id, kind, shift_id, data)
    SELECT gen_random_uuid(), ${teamId}::uuid,
           date_trunc('milliseconds', now()) - ((g / 2) * interval '7 minutes'),
           gen_random_uuid(),
           (ARRAY['shift_created','shift_updated','shift_deleted'])[1 + (g % 3)]::activity_kind,
           gen_random_uuid(),
           jsonb_build_object('title', 'Shift ' || g, 'startsAt', '2031-03-04T09:00:00.000Z', 'endsAt', '2031-03-04T17:00:00.000Z')
    FROM generate_series(0, ${ACTIVITY_ROWS - 1}) AS g`;
  const [count] = await teamPrisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM activity WHERE team_id = ${teamId}::uuid`;
  console.log(`${count?.n} activity rows seeded`);

  writeFileSync(OUTPUT_FILE, JSON.stringify({ teamId, shard, tokens: tokensOut }, null, 2));
  console.log(`tokens written to ${OUTPUT_FILE.pathname} (gitignored - never commit this file)`);

  await closeShards(shards);
}

await main();
