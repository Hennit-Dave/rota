// One-off diagnostic for the activity feed (ADR 0022, cursor-pagination skill). NEVER application code, and it only ever touches the TEST shards:
// `createTestShards` refuses to run without TEST_DATABASE_ALLOWED=true and never falls back to the application's shard URLs.
//
//   npm run db:feed-proof -- seed      10,000+ activity rows for one team on one shard, and a small team on the other (through shardFor, so routing is proven)
//   npm run db:feed-proof -- explain   EXPLAIN (ANALYZE, BUFFERS) of the exact feed query (first page and a deep cursor page) on the big team's PRIMARY
//   npm run db:feed-proof -- clean     delete the two proof teams (their activity goes with them)
//
// The team IDs are derived from fixed labels, so every run finds the same two teams.
import { createHash } from 'node:crypto';
import { createTestShards, getShard, type PoolConfig } from './clients.js';
import { shardFor, type ShardId } from './shard.js';

const BIG_ROWS = 10_000;
const SMALL_ROWS = 50;
const POOL: PoolConfig = { primaryMax: 2 };

/** A canonical UUID derived from a label, searched until it hashes to the shard we want. */
function teamIdFor(label: string, shard: ShardId): string {
  for (let n = 0; ; n++) {
    const h = createHash('sha256').update(`${label}:${n}`).digest('hex');
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    if (shardFor(id) === shard) return id;
  }
}

const BIG = { label: 'feed-proof-big', shard: 'A' as ShardId, name: 'FEED PROOF (big)' };
const SMALL = { label: 'feed-proof-small', shard: 'B' as ShardId, name: 'FEED PROOF (small)' };
const bigId = teamIdFor(BIG.label, BIG.shard);
const smallId = teamIdFor(SMALL.label, SMALL.shard);

const shards = createTestShards(POOL);

async function seedTeam(teamId: string, name: string, rows: number): Promise<void> {
  const prisma = getShard(shards, teamId).primary;
  await prisma.team.upsert({ where: { id: teamId }, create: { id: teamId, name, timeZone: 'Africa/Lagos' }, update: {} });
  await prisma.activity.deleteMany({ where: { teamId } });
  // One row every 7 minutes, two rows per timestamp on purpose: half of all rows have a tie, which is what the `id` tiebreak is for.
  await prisma.$executeRaw`
    INSERT INTO activity (id, team_id, created_at, actor_user_id, kind, shift_id, data)
    SELECT gen_random_uuid(), ${teamId}::uuid,
           date_trunc('milliseconds', now()) - ((g / 2) * interval '7 minutes'),
           gen_random_uuid(),
           (ARRAY['shift_created','shift_updated','shift_deleted'])[1 + (g % 3)]::activity_kind,
           gen_random_uuid(),
           jsonb_build_object('title', 'Shift ' || g, 'startsAt', '2031-03-04T09:00:00.000Z', 'endsAt', '2031-03-04T17:00:00.000Z')
    FROM generate_series(0, ${rows - 1}) AS g`;
  const [count] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM activity WHERE team_id = ${teamId}::uuid`;
  console.log(`team ${teamId} on shard ${shardFor(teamId)}: ${count?.n} activity rows`);
}

async function explain(): Promise<void> {
  const prisma = getShard(shards, bigId).primary;
  const idx = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'activity' ORDER BY indexname`;
  console.log(`shard ${shardFor(bigId)} primary, team ${bigId}`);
  console.log('indexes on activity:');
  for (const i of idx) console.log(`  ${i.indexdef}`);
  const [count] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM activity WHERE team_id = ${bigId}::uuid`;
  console.log(`rows for this team: ${count?.n}`);

  // A deep cursor: the row 5,000 places down the feed (OFFSET is fine in a diagnostic; the app never uses it).
  const [deep] = await prisma.$queryRaw<Array<{ created_at: Date; id: string }>>`
    SELECT created_at, id FROM activity WHERE team_id = ${bigId}::uuid ORDER BY created_at DESC, id DESC OFFSET 5000 LIMIT 1`;
  if (!deep) throw new Error('Seed first: npm run db:feed-proof -- seed');
  const t = deep.created_at.toISOString();

  // These two statements are the exact SQL of listActivity() in src/activity/service.ts, with the same limit (20 + 1).
  const first = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT id, created_at, actor_user_id, kind::text AS kind, shift_id, data FROM activity
     WHERE team_id = '${bigId}'::uuid ORDER BY created_at DESC, id DESC LIMIT 21`,
  );
  const page = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT id, created_at, actor_user_id, kind::text AS kind, shift_id, data FROM activity
     WHERE team_id = '${bigId}'::uuid AND (created_at, id) < ('${t}'::timestamptz, '${deep.id}'::uuid)
     ORDER BY created_at DESC, id DESC LIMIT 21`,
  );
  console.log('\n--- FIRST PAGE (no cursor) ---');
  for (const row of first) console.log(row['QUERY PLAN']);
  console.log(`\n--- DEEP CURSOR PAGE (cursor = row 5000: ${t} ${deep.id}) ---`);
  for (const row of page) console.log(row['QUERY PLAN']);
}

async function clean(): Promise<void> {
  for (const id of [bigId, smallId]) {
    const r = await getShard(shards, id).primary.team.deleteMany({ where: { id } });
    console.log(`deleted team ${id}: ${r.count}`);
  }
}

const command = process.argv[2];
try {
  if (command === 'seed') {
    await seedTeam(bigId, BIG.name, BIG_ROWS);
    await seedTeam(smallId, SMALL.name, SMALL_ROWS);
  } else if (command === 'explain') await explain();
  else if (command === 'clean') await clean();
  else throw new Error('usage: db:feed-proof -- seed | explain | clean');
} finally {
  await Promise.all([shards.A.primary.$disconnect(), shards.B.primary.$disconnect()]);
}
