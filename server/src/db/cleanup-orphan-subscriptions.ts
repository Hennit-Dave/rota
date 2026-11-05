// One-off remediation for issue #71: the test-kit teardown deleted a team without removing its subscription (and, when one had
// been created, its renewal), because it was written before renewals existed. Fixed in server/src/teams/testkit.ts; this script
// removes exactly what was left behind by every run before that fix, on the TEST shards, counted before and after.
//
//   npm run db:cleanup-orphan-subscriptions
//
// Never touches billing_periods, payment_operations or ledger_entries: those are kept even when orphaned (ADR 0026, the ledger
// is append-only; server/src/teams/testkit.ts's own teardown already makes the same choice for the rows it does clean up).
// TEST shards only (createTestShards refuses anything else).
import { createTestShards } from './clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';

async function orphanSubscriptions(db: PrismaClient): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM subscriptions s WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = s.team_id)`;
  return Number(row?.n ?? 0);
}

async function orphanRenewals(db: PrismaClient): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM renewals r WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = r.team_id)`;
  return Number(row?.n ?? 0);
}

async function cleanShard(label: 'A' | 'B', db: PrismaClient): Promise<void> {
  const subsBefore = await orphanSubscriptions(db);
  const renewalsBefore = await orphanRenewals(db);

  const workRowsDeleted = await db.$executeRaw`
    DELETE FROM work_rows WHERE kind = 'renewal' AND payload->>'teamId' IN (
      SELECT s.team_id::text FROM subscriptions s WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = s.team_id)
    )`;
  const renewalsDeleted = await db.$executeRaw`DELETE FROM renewals r WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = r.team_id)`;
  const subsDeleted = await db.$executeRaw`DELETE FROM subscriptions s WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = s.team_id)`;

  const subsAfter = await orphanSubscriptions(db);
  const renewalsAfter = await orphanRenewals(db);

  console.log(`shard ${label}:`);
  console.log(`  orphaned subscriptions: before=${subsBefore} after=${subsAfter} (deleted ${subsDeleted})`);
  console.log(`  orphaned renewals:      before=${renewalsBefore} after=${renewalsAfter} (deleted ${renewalsDeleted})`);
  console.log(`  orphaned 'renewal' work rows deleted: ${workRowsDeleted}`);
}

async function main(): Promise<void> {
  const shards = createTestShards({ primaryMax: 2 });
  try {
    await cleanShard('A', shards.A.primary);
    await cleanShard('B', shards.B.primary);
  } finally {
    await shards.A.primary.$disconnect();
    await shards.B.primary.$disconnect();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
