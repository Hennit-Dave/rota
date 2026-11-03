// Integration tests leave no work rows behind (issue #62). Preloaded into EVERY integration test file by the `test:integration` scripts (`--import`), so a new test
// needs no cleanup code of its own for work rows.
//
// Why: the reconcile sweep walks every pending row on a shard. Tests that make renewals, emails and push events (the Owner's failed-renewal notices) left hundreds of
// pending rows on the test shards, some due years from now, and the reconcile tests then timed out (PR #61 and #63).
//
// How: each test file runs in its own process, one at a time (`--test-concurrency=1`). Before the file's tests, this records the database's own clock and how many
// pending or claimed rows each TEST shard holds. After them, it removes the work rows created since then (the rows this file's tests made, directly or through
// the code they ran), except the few that another table still points at (an invitation's email, an auth token's email, a Stripe event): those are marked `failed`
// instead, so nothing is left for the sweep. Then it checks the count of pending and claimed rows is what it was before, and FAILS THE FILE if it is not.
//
// It only ever touches the TEST shards (`createTestShards` refuses anything else). It assumes the test shards are used by one test process at a time, which the
// reconcile tests already require: a proof worker running against the test shards while integration tests run would have its rows removed too. If the shards
// cannot be reached the guard logs one line and stands aside, so an unrelated outage does not fail every file twice.
import { after, before } from 'node:test';
import { createTestShards, type Shards } from '../db/clients.js';
import type { ShardId } from '../db/shard.js';

const SHARD_IDS: ShardId[] = ['A', 'B'];

let shards: Shards | null = null;
const started = new Map<ShardId, { at: Date; pending: number }>();

async function pendingCount(shard: ShardId): Promise<number> {
  const rows = await shards![shard].primary.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM work_rows WHERE status IN ('pending'::work_status, 'claimed'::work_status)`;
  return rows[0]!.n;
}

before(async () => {
  try {
    shards = createTestShards({ primaryMax: 1 });
    for (const shard of SHARD_IDS) {
      const clock = await shards[shard].primary.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
      started.set(shard, { at: clock[0]!.at, pending: await pendingCount(shard) });
    }
  } catch (err) {
    console.warn(`[work-row-guard] stood aside: could not read the test shards (${err instanceof Error ? err.message.split('\n')[0] : 'error'})`);
    await shards?.A.primary.$disconnect().catch(() => undefined);
    await shards?.B.primary.$disconnect().catch(() => undefined);
    shards = null;
  }
});

after(async () => {
  if (!shards) return;
  const problems: string[] = [];
  try {
    for (const shard of SHARD_IDS) {
      const start = started.get(shard)!;
      const db = shards[shard].primary;
      const made = await db.$queryRaw<Array<{ total: number; open: number }>>`
        SELECT count(*)::int AS total, (count(*) FILTER (WHERE status IN ('pending'::work_status, 'claimed'::work_status)))::int AS open
        FROM work_rows WHERE created_at >= ${start.at}`;
      const removed = await db.$executeRaw`
        DELETE FROM work_rows w
        WHERE w.created_at >= ${start.at}
          AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.email_work_row_id = w.id)
          AND NOT EXISTS (SELECT 1 FROM auth_tokens t WHERE t.email_work_row_id = w.id)
          AND NOT EXISTS (SELECT 1 FROM stripe_events e WHERE e.work_row_id = w.id)`;
      const finished = await db.$executeRaw`
        UPDATE work_rows
        SET status = 'failed'::work_status, failure_reason = 'test cleanup (work-row guard)', claim_token = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE created_at >= ${start.at} AND status IN ('pending'::work_status, 'claimed'::work_status)`;
      const after = await pendingCount(shard);
      console.log(
        `[work-row-guard] shard ${shard}: pending+claimed before=${start.pending} after=${after}; this file made ${made[0]!.total} work rows (${made[0]!.open} still open), removed ${removed}, finished ${finished}`,
      );
      if (after !== start.pending) problems.push(`shard ${shard}: pending+claimed rows were ${start.pending} before this file and ${after} after it`);
    }
  } finally {
    await shards.A.primary.$disconnect();
    await shards.B.primary.$disconnect();
  }
  if (problems.length > 0) throw new Error(`work-row guard: this test file left work rows behind: ${problems.join('; ')}`);
});
