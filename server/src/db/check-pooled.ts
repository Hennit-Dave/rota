// Pooled-connection check for both shards (infrastructure gate: "Both Neon shards connected").
// Exercises: a raw query, a Prisma model query (extended protocol / prepared statements through the
// transaction-mode pooler), and a short transaction. Prints results only, never URLs.
// On any failure it STOPS and reports. It never retries on a direct URL.
import { createShards } from './clients.js';
import type { ShardId } from './shard.js';

const shards = createShards({ primaryMax: 3 });
let failed = false;

for (const id of ['A', 'B'] as ShardId[]) {
  const db = shards[id].primary;
  try {
    const info = await db.$queryRaw<{ db: string; in_recovery: boolean }[]>`
      SELECT current_database() AS db, pg_is_in_recovery() AS in_recovery`;
    const count = await db.workRow.count();
    const txCount = await db.$transaction(async (tx) => tx.workRow.count());
    console.log(
      `shard ${id}: pooled OK; database=${info[0]?.db}; pg_is_in_recovery=${info[0]?.in_recovery}; ` +
        `model query work_rows count=${count}; transaction count=${txCount}`,
    );
  } catch (err) {
    failed = true;
    const e = err as { code?: string; message?: string };
    console.error(`shard ${id}: pooled FAILED code=${e.code ?? 'n/a'} message=${(e.message ?? '').split('\n')[0]}`);
  } finally {
    await db.$disconnect();
  }
}

if (failed) {
  console.error('POOLED CHECK FAILED. Stop and report. Do NOT switch runtime traffic to direct URLs.');
  process.exit(1);
}
console.log('POOLED CHECK OK: both shards reachable through the pooler.');
