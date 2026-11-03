// Prints how many pending and claimed work rows each TEST shard holds, as one line per shard: the before-and-after check for the integration tests (issue #62).
//   npm run test:rows
// Test shards only (`createTestShards` refuses anything else).
import { createTestShards } from '../db/clients.js';

const shards = createTestShards({ primaryMax: 1 });
for (const shard of ['A', 'B'] as const) {
  const rows = await shards[shard].primary.$queryRaw<Array<{ kind: string; n: number }>>`
    SELECT kind, count(*)::int AS n FROM work_rows WHERE status IN ('pending'::work_status, 'claimed'::work_status) GROUP BY kind ORDER BY kind`;
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  console.log(`test shard ${shard}: pending+claimed work rows = ${total}${rows.length ? ` (${rows.map((r) => `${r.kind} ${r.n}`).join(', ')})` : ''}`);
}
process.exit(0);
