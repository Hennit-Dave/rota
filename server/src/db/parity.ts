// Migration parity check (data.md test 3): both shards must report the same applied migrations.
// Reads _prisma_migrations on each shard through the DIRECT url. Prints names only, never URLs.
import pg from 'pg';

async function applied(label: string, varName: string): Promise<string[]> {
  const connectionString = process.env[varName];
  if (!connectionString) throw new Error(`${varName} is not set.`);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
       ORDER BY migration_name`,
    );
    const names = res.rows.map((r) => r.migration_name);
    console.log(`shard ${label}: ${names.length} applied`);
    for (const n of names) console.log(`  ${n}`);
    return names;
  } finally {
    await client.end();
  }
}

const a = await applied('A', 'SHARD_A_DIRECT_URL');
const b = await applied('B', 'SHARD_B_DIRECT_URL');

if (JSON.stringify(a) === JSON.stringify(b)) {
  console.log('PARITY OK: both shards report the same applied migrations.');
} else {
  console.error('PARITY MISMATCH: shards differ. Stop and fix before any further work.');
  process.exit(1);
}
