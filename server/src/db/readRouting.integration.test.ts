import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeShards, createShards, createTestShards, type Shards } from './clients.js';
import { createReadRouting, READ_YOUR_WRITES_MS, type DbRoute, type ReadDb } from './readRouting.js';

// The read-routing function against the REAL read replicas of the two test projects (ADR 0037). Nothing is written: every query is a read.
// data.md tests 4, 6, 7 and 8 with real clocks and real databases. `pg_is_in_recovery()` is true on a replica and false on a primary.
const TEAM_A = '00000000-0000-4000-8000-000000000001'; // shard A (data.md test vectors)
const TEAM_B = '00000000-0000-4000-8000-000000000002'; // shard B
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inRecovery = async (db: ReadDb) => ((await db.$queryRaw<Array<{ r: boolean }>>`SELECT pg_is_in_recovery() AS r`)[0] as { r: boolean }).r;

let shards: Shards;
const replicaQueries: string[] = [];
const replicaErrors: unknown[] = [];
let reads: ReturnType<typeof createReadRouting>;

before(async () => {
  shards = createTestShards({ primaryMax: 2, replicaMax: 2, logReplicaQueries: true });
  for (const id of ['A', 'B'] as const) {
    (shards[id].reader!.$replica() as unknown as { $on(e: 'query', cb: (q: { query: string }) => void): void }).$on('query', (q) => {
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(q.query)) replicaQueries.push(`${id}:${q.query.slice(0, 50)}`);
    });
  }
  reads = createReadRouting({ shards, onReplicaError: (e) => replicaErrors.push(e) });
  // The process has to be older than the startup window, or every read goes to the primary (reason startup, data.md test 5).
  await sleep(READ_YOUR_WRITES_MS + 300);
});
after(async () => {
  reads.stop();
  await closeShards(shards);
});

const routeOf = async (teamId: string, userId: string, primaryRequired = false) => {
  let route: DbRoute | undefined;
  const recovery = await reads.run(teamId, { userId, primaryRequired, onRoute: (r) => (route = r) }, inRecovery);
  return { route, recovery };
};

describe('opted-in reads hit the REAL replica', () => {
  it('pg_is_in_recovery() is true for a read with no reason to use the primary, on BOTH shards; the plain primary clients say false', async () => {
    assert.deepEqual(await routeOf(TEAM_A, OTHER), { route: 'none', recovery: true });
    assert.deepEqual(await routeOf(TEAM_B, OTHER), { route: 'none', recovery: true });
    assert.equal(await inRecovery(shards.A.primary), false);
    assert.equal(await inRecovery(shards.B.primary), false);
  });

  it('a primary-required read goes to the primary at any time (data.md test 7)', async () => {
    assert.deepEqual(await routeOf(TEAM_A, OTHER, true), { route: 'primary-required', recovery: false });
  });
});

describe('read-your-own-writes, with real clocks (data.md tests 4 and 6)', () => {
  it('right after a write the SAME user reads the primary for 5 s; another user and the time after 5 s read the replica', async () => {
    const wroteAt = Date.now();
    reads.markWrite(USER);

    await sleep(1_000);
    assert.deepEqual(await routeOf(TEAM_A, USER), { route: 'marker', recovery: false }, 'at 1 s: the primary');
    assert.deepEqual(await routeOf(TEAM_A, OTHER), { route: 'none', recovery: true }, 'another user is not held back');

    await sleep(wroteAt + 6_000 - Date.now());
    assert.deepEqual(await routeOf(TEAM_A, USER), { route: 'none', recovery: true }, 'at 6 s: the replica again');
  });
});

describe('a QUERY error on the real replica', () => {
  it('is not retried on the primary: the caller gets the database error, nothing is reported, the route stays none', async () => {
    const errorsBefore = replicaErrors.length;
    const before = replicaQueries.length;
    const routes: DbRoute[] = [];
    await assert.rejects(
      reads.run(TEAM_A, { userId: OTHER, onRoute: (r) => routes.push(r) }, (db) => db.$queryRaw`SELECT * FROM table_that_does_not_exist`),
      (e: { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }) => e.meta?.driverAdapterError?.cause?.originalCode === '42P01',
    );
    assert.deepEqual(routes, ['none'], 'asked the replica once; never replica-failed');
    assert.equal(replicaErrors.length, errorsBefore, 'no reachability failure was reported');
    assert.equal(replicaQueries.length - before, 1, 'the replica was asked exactly once: no second attempt');
  });
});

describe('raw and model reads agree (data.md test 8)', () => {
  it('in the same state a raw read and a model read hit the same client: both on the replica, or neither', async () => {
    const both = (teamId: string, userId: string) =>
      reads.run(teamId, { userId }, async (db) => {
        await db.$queryRaw`SELECT 1 AS one`;
        await db.shift.count({ where: { teamId } });
      });

    const before = replicaQueries.length;
    await both(TEAM_A, OTHER); // no reason to use the primary
    assert.equal(replicaQueries.length - before, 2, 'the raw read and the model read were both asked of the replica');

    reads.markWrite(USER);
    const mid = replicaQueries.length;
    await both(TEAM_A, USER); // the user's own recent write
    assert.equal(replicaQueries.length - mid, 0, 'neither reached the replica: both went to the primary');
  });
});

describe('a replica that cannot be reached', () => {
  it('is reported and the primary answers, so the caller still gets its data', async () => {
    // Replica URLs pointing at a port nothing listens on; the primaries are the real test shards.
    const broken = createShards(
      { primaryMax: 1, replicaMax: 1 },
      { A: process.env.TEST_SHARD_A_DATABASE_URL!, B: process.env.TEST_SHARD_B_DATABASE_URL! },
      { A: 'postgresql://nobody:nothing@127.0.0.1:1/none', B: 'postgresql://nobody:nothing@127.0.0.1:1/none' },
    );
    const errors: unknown[] = [];
    const routing = createReadRouting({ shards: broken, windowMs: 0, onReplicaError: (e) => errors.push(e) });
    try {
      const routes: DbRoute[] = [];
      const recovery = await routing.run(TEAM_A, { userId: OTHER, onRoute: (r) => routes.push(r) }, inRecovery);
      assert.equal(recovery, false, 'answered by the primary');
      assert.equal(errors.length, 1, 'the replica failure was reported once');
      assert.deepEqual(routes, ['none', 'replica-failed']);
    } finally {
      routing.stop();
      await closeShards(broken);
    }
  });
});
