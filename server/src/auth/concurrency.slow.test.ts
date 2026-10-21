import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createTestShards, type Shards } from '../db/clients.js';
import { bearer, startAuthTestApp, type TestApp, type TestSession } from './testkit.js';

/**
 * The slow tests: concurrency and races. They hold database locks on purpose and fire many requests, so they take
 * minutes against Neon. Run with `npm run test:integration:slow` (README); `npm run test:all` includes them.
 *
 * security.md test 8, "revocation race": log out everywhere DURING a refresh, and no usable token may survive.
 *
 * Two versions. The deterministic one makes the interleaving happen on purpose: the test itself holds the family
 * row lock, so the requests under test queue behind it in a known order, and it releases the lock when it chooses.
 * The repeated one fires the real requests at the same time with random offsets, many times, and checks the same
 * invariant whichever side wins. Neither can pass by luck: the invariant is checked on every token involved.
 */
let app: TestApp;
let locker: Shards;
before(async () => {
  app = await startAuthTestApp();
  // A separate pool for the test's own lock and its observation queries, so it never competes with the app's 3 connections.
  locker = createTestShards({ primaryMax: 2 });
});
after(async () => {
  await locker.A.primary.$disconnect();
  await locker.B.primary.$disconnect();
  await app.stop();
});

const refresh = (refreshToken: string) => app.post('/auth/refresh', { refreshToken });
const expect401 = (r: { status: number; body: any; headers: Headers }) => {
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'unauthenticated');
};
async function user() {
  const u = await app.seedUser();
  return { u, s: await app.startSession(u.id) };
}
const logoutAll = (accessToken: string) => app.post('/auth/logout-all', undefined, bearer(accessToken));

type Tx = Parameters<Parameters<Shards['A']['primary']['$transaction']>[0]>[0];

/** Holds the family row lock until `release()`; `release(work)` runs `work` on the SAME transaction before it commits. */
function holdFamilyLock(familyId: string) {
  let release!: (work?: (tx: Tx) => Promise<void>) => void;
  const releaseSignal = new Promise<((tx: Tx) => Promise<void>) | undefined>((r) => (release = r));
  let locked!: () => void;
  const lockedSignal = new Promise<void>((r) => (locked = r));
  const done = locker.A.primary.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM refresh_token_families WHERE id = ${familyId}::uuid FOR UPDATE`;
      locked();
      const work = await releaseSignal;
      if (work) await work(tx);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return { held: lockedSignal, release: (work?: (tx: Tx) => Promise<void>) => (release(work), done) };
}

/** How many database sessions are currently blocked waiting on a row lock taken by a `FOR UPDATE` statement. */
async function waiters(): Promise<number> {
  const [row] = await locker.A.primary.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock'
      AND query ILIKE '%FOR UPDATE%'
  `;
  return Number(row!.n);
}

async function waitForWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await waiters()) >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`expected ${n} request(s) blocked on the family lock, saw ${await waiters()}`);
}

/** The invariant: after both operations finished, nothing from this session is usable. */
async function assertNothingSurvives(original: TestSession, refreshReply: { status: number; body: any }) {
  const refreshTokens = [original.refreshToken];
  const accessTokens = [original.accessToken];
  if (refreshReply.status === 200) {
    refreshTokens.push(refreshReply.body.session.refreshToken);
    accessTokens.push(refreshReply.body.session.accessToken);
  }
  for (const token of accessTokens) assert.equal((await app.get('/auth/me', bearer(token))).status, 401, 'an access token survived');
  for (const token of refreshTokens) assert.equal((await refresh(token)).status, 401, 'a refresh token survived');
  const family = await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: original.familyId } });
  assert.notEqual(family.revokedAt, null);
}

test('deterministic, revocation commits FIRST: the refresh that was already waiting sees it and is refused', async () => {
  const u = await app.seedUser();
  const s = await app.startSession(u.id);
  const lock = holdFamilyLock(s.familyId);
  await lock.held;

  const pending = refresh(s.refreshToken);
  await waitForWaiters(1);
  // Log-out-everywhere's effect, applied inside the transaction that holds the lock, then committed.
  await lock.release(async (tx) => {
    await tx.$executeRaw`
      UPDATE refresh_token_families SET revoked_at = now(), revoked_reason = 'logout_all' WHERE user_id = ${u.id}::uuid AND revoked_at IS NULL`;
  });

  const reply = await pending;
  assert.equal(reply.status, 401, 'the refresh must not succeed after the revocation committed');
  const rows = await app.db.refreshToken.findMany({ where: { familyId: s.familyId } });
  assert.equal(rows.length, 1, 'no replacement token was issued');
  assert.equal(rows[0]!.usedAt, null, 'and the presented token was not consumed');
  await assertNothingSurvives(s, reply);
});

test('deterministic, refresh commits FIRST: logout-all then revokes the token that refresh just issued', async () => {
  const u = await app.seedUser();
  const s = await app.startSession(u.id);
  const lock = holdFamilyLock(s.familyId);
  await lock.held;

  const refreshing = refresh(s.refreshToken);
  await waitForWaiters(1); // the refresh is queued on the lock first
  const loggingOut = logoutAll(s.accessToken); // its session check passes (not revoked yet), then it queues behind the refresh
  await waitForWaiters(2);
  await lock.release();

  const [refreshed, loggedOut] = await Promise.all([refreshing, loggingOut]);
  assert.equal(refreshed.status, 200, 'the refresh was first in the queue, so it succeeded');
  assert.equal(loggedOut.status, 204);
  await assertNothingSurvives(s, refreshed);
  assert.ok(refreshed.body.session.refreshToken, 'a token WAS issued, and it is dead too');
});

const ITERATIONS = 15;

test(`repeated (${ITERATIONS} races): logout-all and refresh fired together, with random offsets; nothing ever survives`, async () => {
  const u = await app.seedUser();
  const tally = { refreshWon: 0, logoutWon: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const s = await app.startSession(u.id);
    // Random offsets over roughly the length of a refresh (it makes a Valkey call and several queries; logout-all
    // makes fewer), alternating who starts first, so the logout lands before, during and after the refresh.
    const delayA = i % 2 === 0 ? 0 : Math.floor(Math.random() * 300);
    const delayB = i % 2 === 0 ? Math.floor(Math.random() * 2500) : 0;
    const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const [refreshed, loggedOut] = await Promise.all([
      later(delayA).then(() => refresh(s.refreshToken)),
      later(delayB).then(() => logoutAll(s.accessToken)),
    ]);
    assert.equal(loggedOut.status, 204, `iteration ${i}: logout-all must succeed (got ${loggedOut.status})`);
    assert.ok([200, 401].includes(refreshed.status), `iteration ${i}: refresh gave ${refreshed.status}`);
    if (refreshed.status === 200) tally.refreshWon++;
    else tally.logoutWon++;
    await assertNothingSurvives(s, refreshed);
  }
  console.log(`  race outcomes over ${ITERATIONS} runs: refresh committed first ${tally.refreshWon}x, logout-all first ${tally.logoutWon}x`);
});

test('CONCURRENT refresh (#7): two at once give exactly one 200; the winner\'s new token is then dead', async () => {
  const { s } = await user();
  const [a, b] = await Promise.all([refresh(s.refreshToken), refresh(s.refreshToken)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 401], 'one winner, one reuse');

  const winner = a.status === 200 ? a : b;
  expect401(await refresh(winner.body.session.refreshToken));
  expect401(await app.get('/auth/me', bearer(winner.body.session.accessToken)));
  const family = await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: s.familyId } });
  assert.equal(family.revokedReason, 'reuse_detected');
});

test('ATOMIC consumption (data.md #9): three simultaneous uses of one token give exactly one success', async () => {
  const { s } = await user();
  const results = await Promise.all([refresh(s.refreshToken), refresh(s.refreshToken), refresh(s.refreshToken)]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 401).length, 2);
  const live = await app.db.refreshToken.count({ where: { familyId: s.familyId, usedAt: null } });
  assert.equal(live, 1, 'the family never ends up with two live tokens');
});

test('logout and logout-all run together without deadlock or a 500 (families are locked in a fixed order)', async () => {
  const u = await app.seedUser();
  const sessions = await Promise.all([1, 2, 3].map(() => app.startSession(u.id)));
  const results = await Promise.all([
    app.post('/auth/logout-all', undefined, bearer(sessions[0]!.accessToken)),
    app.post('/auth/logout-all', undefined, bearer(sessions[1]!.accessToken)),
    app.post('/auth/logout', undefined, bearer(sessions[2]!.accessToken)),
    refresh(sessions[1]!.refreshToken),
  ]);
  for (const r of results) assert.ok([200, 204, 401].includes(r.status), `unexpected ${r.status}`);
  for (const s of sessions) expect401(await app.get('/auth/me', bearer(s.accessToken)));
});
