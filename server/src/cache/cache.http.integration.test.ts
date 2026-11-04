import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';

// The team cache (ADR 0038) over real HTTP, against the REAL Valkey, with the test shards. The cache talks to Valkey through a spy that records every command
// and can be told to fail. caching.md tests 1 to 10, with the evidence each one needs: the request log's `cache` and `dbRoute`, the cache's commands, the
// instrumented database queries, and the keys and TTLs in Valkey itself.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The shared app's TTLs are long, so a slow multi-step test over the real network never loses an entry to expiry halfway through. The failed-invalidation test
// starts its own app with a SHORT calendar TTL, so it need not wait out a real one.
const SHARED_TTL = 120;
const CAL_TTL = 20;
const FROM = '2031-03-03T00:00:00.000Z';
const TO = '2031-03-10T00:00:00.000Z';
const at = (hour: number) => new Date(Date.UTC(2031, 2, 4, hour)).toISOString();

type Entry = { msg?: string; level?: string; method?: string; cache?: string; dbRoute?: string; status?: number; reason?: string; teamId?: string };
const logsOf = (a: TeamsTestApp): Entry[] => a.logLines().map((l) => JSON.parse(l) as Entry);
const lastGet = (a: TeamsTestApp) => logsOf(a).filter((l) => l.msg === 'request' && l.method === 'GET').at(-1)!;

let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp({ cache: { enabled: true, ttlSeconds: { cal: SHARED_TTL, feed: SHARED_TTL, roster: SHARED_TTL } } });
  // The process must be older than the startup window, or every read bypasses the cache (reason startup).
  await sleep(5_300);
});
after(() => app.stop());

async function setup(a: TeamsTestApp = app) {
  const owner = await a.seedUser('Olive Owner');
  const { teamId } = await a.seedTeam({ ownerId: owner.id, name: 'The Olive Room' });
  const manager = await a.seedUser('Maya Manager');
  await a.addMember(teamId, manager.id, 'manager');
  const amara = await a.seedUser('Amara Staff');
  await a.addMember(teamId, amara.id, 'staff');
  const bola = await a.seedUser('Bola Staff');
  await a.addMember(teamId, bola.id, 'staff');
  const h = async (id: string) => bearer((await a.signIn(id)).accessToken);
  return { teamId, owner, manager, amara, bola, ownerH: await h(owner.id), managerH: await h(manager.id), amaraH: await h(amara.id), bolaH: await h(bola.id) };
}
type T = Awaited<ReturnType<typeof setup>>;

const urls = (teamId: string) => ({
  cal: `/teams/${teamId}/shifts?from=${FROM}&to=${TO}`,
  feed: `/teams/${teamId}/activity`,
  roster: `/teams/${teamId}/members`,
});
type Kind = keyof ReturnType<typeof urls>;
const KINDS: Kind[] = ['cal', 'feed', 'roster'];

/** One GET of one cached endpoint, with what the request log and the cache recorded about it. */
async function read(a: TeamsTestApp, t: T, kind: Kind, headers: Record<string, string>) {
  a.clearCacheCommands();
  a.clearQueryLog();
  const res = await a.get(urls(t.teamId)[kind], headers);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { res, log: lastGet(a), commands: a.cacheCommands(), queries: a.queryLog() };
}
const statuses = async (a: TeamsTestApp, t: T, headers: Record<string, string>) => {
  const out: Record<string, string | undefined> = {};
  for (const k of KINDS) out[k] = (await read(a, t, k, headers)).log.cache;
  return out;
};
/** After this, all three are filled: one read fills what is missing, the second is a hit (and proves it). */
async function warm(a: TeamsTestApp, t: T, headers: Record<string, string>) {
  await statuses(a, t, headers);
  assert.deepEqual(await statuses(a, t, headers), { cal: 'hit', feed: 'hit', roster: 'hit' });
}

async function publish(a: TeamsTestApp, t: T, headers: Record<string, string>, title: string, start: number, end: number, assignee: string | null) {
  const res = await a.post(`/teams/${t.teamId}/shifts`, { title, startsAt: at(start), endsAt: at(end), assignedUserId: assignee }, headers);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.shift.id as string;
}

/** Every key of the team in the real Valkey has a TTL, and none outlives what config allows (caching.md test 7). */
async function assertEveryKeyHasATtl(a: TeamsTestApp, teamId: string, entryTtl = SHARED_TTL) {
  const entries = await a.cacheEntries(teamId);
  assert.ok(entries.length > 0, 'the team has cache keys');
  const limit = (key: string) => (key.endsWith(':gen') ? 600 : entryTtl);
  for (const { key, ttl } of entries) assert.ok(ttl > 0 && ttl <= limit(key), `${key} has a TTL of ${ttl}s (at most ${limit(key)})`);
}

describe('hit and miss (caching.md test 1), a fill reads the primary, a hit reads no database', () => {
  test('calendar, feed and roster: the first read misses and fills from the PRIMARY; the second hits, asks the database for the data, and answers the same', async () => {
    const t = await setup();
    await publish(app, t, t.ownerH, 'Morning service', 9, 13, t.amara.id);

    for (const kind of KINDS) {
      const miss = await read(app, t, kind, t.bolaH);
      assert.equal(miss.log.cache, 'miss', `${kind}: first read`);
      assert.equal(miss.log.dbRoute, 'primary-required', `${kind}: a fill is a primary read (the replica test at the end shows the replica is asked nothing)`);
      assert.ok(miss.commands.some((c) => c.startsWith('set cache:v1:team:') && c.includes(`:${kind}:`) && !c.includes(':gen') && /ex=\d+$/.test(c)), `${kind}: stored with a TTL`);

      const hit = await read(app, t, kind, t.bolaH);
      assert.equal(hit.log.cache, 'hit', `${kind}: second read`);
      assert.deepEqual(hit.res.body, miss.res.body, `${kind}: the same answer`);
      assert.ok(hit.commands.every((c) => c.startsWith('get ')), `${kind}: a hit only reads Valkey`);
      assert.ok(hit.queries.length < miss.queries.length, `${kind}: fewer database queries on a hit (${hit.queries.length} < ${miss.queries.length})`);
      const dataRead = { cal: 'Shift.findMany', roster: 'Membership.findMany' }[kind as 'cal' | 'roster'];
      if (dataRead) {
        assert.ok(miss.queries.some((q) => q.endsWith(dataRead)), `${kind}: the miss read ${dataRead}`);
        assert.ok(!hit.queries.some((q) => q.endsWith(dataRead)), `${kind}: the hit did not`);
      }
    }
    // A hit never skips authorisation: a stranger with a valid token is still turned away, and a no-token request too.
    const stranger = await app.seedUser('Stranger');
    const strangerH = bearer((await app.signIn(stranger.id)).accessToken);
    for (const kind of KINDS) {
      assert.equal((await app.get(urls(t.teamId)[kind], strangerH)).status, 404, `${kind}: another team's caller`);
      assert.equal((await app.get(urls(t.teamId)[kind])).status, 401, `${kind}: no token`);
    }
    // The roster keeps its shape through the cache: the joined-at time is an ISO string, as res.json always sent it.
    const roster = (await read(app, t, 'roster', t.bolaH)).res.body.members as Array<{ joinedAt: unknown; name: string }>;
    assert.ok(roster.length >= 4);
    assert.match(String(roster[0]!.joinedAt), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    await assertEveryKeyHasATtl(app, t.teamId);
    // The stats line has counted them (the same line is written every 60 s in production).
    app.cache.flushStats();
    const line = logsOf(app).find((l) => l.msg === 'cache_stats') as unknown as Record<string, number>;
    assert.ok(Number(line.cacheHits) >= 3 && Number(line.cacheMisses) >= 3 && Number(line.cacheHitRate) > 0 && Number(line.cacheHitRate) < 1, JSON.stringify(line));
  });
});

describe('invalidation at every real write site (caching.md test 2): the next read misses and shows the change', () => {
  test('shifts: create, edit and delete replace the calendar and the feed, and leave the roster alone', async () => {
    const t = await setup();
    await warm(app, t, t.bolaH);

    // create
    const id = await publish(app, t, t.ownerH, 'Morning service', 9, 13, t.amara.id);
    assert.deepEqual(await statuses(app, t, t.bolaH), { cal: 'miss', feed: 'miss', roster: 'hit' }, 'create');
    assert.ok((await read(app, t, 'cal', t.bolaH)).res.body.shifts.some((s: { id: string }) => s.id === id), 'the calendar shows the new shift');
    assert.ok((await read(app, t, 'feed', t.bolaH)).res.body.items.some((i: { kind: string; shiftId: string }) => i.kind === 'shift_created' && i.shiftId === id), 'and the feed says so');

    // edit
    assert.equal((await app.patch(`/teams/${t.teamId}/shifts/${id}`, { title: 'Brunch' }, t.ownerH)).status, 200);
    assert.deepEqual(await statuses(app, t, t.bolaH), { cal: 'miss', feed: 'miss', roster: 'hit' }, 'edit');
    assert.equal((await read(app, t, 'cal', t.bolaH)).res.body.shifts.find((s: { id: string }) => s.id === id).title, 'Brunch');
    await warm(app, t, t.bolaH);

    // delete
    assert.equal((await app.del(`/teams/${t.teamId}/shifts/${id}`, t.ownerH)).status, 204);
    assert.deepEqual(await statuses(app, t, t.bolaH), { cal: 'miss', feed: 'miss', roster: 'hit' }, 'delete');
    assert.ok(!(await read(app, t, 'cal', t.bolaH)).res.body.shifts.some((s: { id: string }) => s.id === id), 'the shift is gone from the calendar');
    assert.ok((await read(app, t, 'feed', t.bolaH)).res.body.items.some((i: { kind: string }) => i.kind === 'shift_deleted'));
  });

  test('swaps: a request replaces the feed only, an approval the calendar and the feed, a rejection the feed only', async () => {
    const t = await setup();
    const morning = await publish(app, t, t.ownerH, 'Morning service', 9, 13, t.amara.id);
    const evening = await publish(app, t, t.ownerH, 'Evening service', 17, 22, t.bola.id);
    const ask = (offered: string, requested: string) =>
      app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: offered, requestedShiftId: requested }, { ...t.amaraH, 'idempotency-key': randomUUID() });
    // Staff who are neither party read, so the writer's own 5 s window never interferes.
    const reader = t.managerH;
    await warm(app, t, reader);

    // request
    const first = await ask(morning, evening);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(await statuses(app, t, reader), { cal: 'hit', feed: 'miss', roster: 'hit' }, 'request: the feed only');
    assert.ok((await read(app, t, 'feed', reader)).res.body.items.some((i: { kind: string }) => i.kind === 'swap_requested'));
    await warm(app, t, reader);

    // approve
    const approve = await app.post(`/teams/${t.teamId}/swaps/${first.body.swap.id}/approve`, {}, t.ownerH);
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.deepEqual(await statuses(app, t, reader), { cal: 'miss', feed: 'miss', roster: 'hit' }, 'approve: the calendar and the feed');
    const cal = (await read(app, t, 'cal', reader)).res.body.shifts as Array<{ id: string; assignee: { id: string } }>;
    assert.equal(cal.find((s) => s.id === morning)!.assignee.id, t.bola.id, 'the shifts changed hands, and the cached calendar shows it');
    assert.equal(cal.find((s) => s.id === evening)!.assignee.id, t.amara.id);
    await warm(app, t, reader);

    // another request, then reject
    const second = await app.post(`/teams/${t.teamId}/swaps`, { offeredShiftId: evening, requestedShiftId: morning }, { ...t.amaraH, 'idempotency-key': randomUUID() });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    await warm(app, t, reader);
    const reject = await app.post(`/teams/${t.teamId}/swaps/${second.body.swap.id}/reject`, {}, t.ownerH);
    assert.equal(reject.status, 200, JSON.stringify(reject.body));
    assert.deepEqual(await statuses(app, t, reader), { cal: 'hit', feed: 'miss', roster: 'hit' }, 'reject: the feed only');
    assert.ok((await read(app, t, 'feed', reader)).res.body.items.some((i: { kind: string }) => i.kind === 'swap_rejected'));
  });

  test('a repeat of the same Idempotency-Key writes nothing, so it replaces nothing', async () => {
    const t = await setup();
    const morning = await publish(app, t, t.ownerH, 'Morning service', 9, 13, t.amara.id);
    const evening = await publish(app, t, t.ownerH, 'Evening service', 17, 22, t.bola.id);
    const key = randomUUID();
    const body = { offeredShiftId: morning, requestedShiftId: evening };
    assert.equal((await app.post(`/teams/${t.teamId}/swaps`, body, { ...t.amaraH, 'idempotency-key': key })).status, 201);
    await warm(app, t, t.managerH);
    app.clearCacheCommands();
    assert.equal((await app.post(`/teams/${t.teamId}/swaps`, body, { ...t.amaraH, 'idempotency-key': key })).status, 200, 'the stored answer');
    assert.deepEqual(app.cacheCommands(), [], 'nothing was written, so no generation was replaced');
    assert.deepEqual(await statuses(app, t, t.managerH), { cal: 'hit', feed: 'hit', roster: 'hit' });
  });

  test('accepting an invitation replaces the roster only', async () => {
    const owner = await app.seedUser('Olive Owner');
    const { teamId, shard } = await app.seedTeam({ ownerId: owner.id, name: 'The Pine Room' });
    const bola = await app.seedUser('Bola Staff');
    await app.addMember(teamId, bola.id, 'staff');
    const t = { teamId } as T;
    const bolaH = bearer((await app.signIn(bola.id)).accessToken);
    const ownerH = bearer((await app.signIn(owner.id)).accessToken);
    await warm(app, t, bolaH);

    const invitee = await app.seedUser('Ife Invitee');
    const invited = await app.post(`/teams/${teamId}/invitations`, { email: invitee.email, role: 'staff' }, ownerH);
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    assert.deepEqual(await statuses(app, t, bolaH), { cal: 'hit', feed: 'hit', roster: 'hit' }, 'a pending invitation is not on the roster, so nothing is replaced');
    const row = await app.raw[shard].primary.invitation.findUniqueOrThrow({ where: { id: invited.body.invitation.id } });
    const token = await app.tokenFromEmailRow(row.emailWorkRowId!, teamId);

    const accepted = await app.post('/invitations/accept', { token }, bearer((await app.signIn(invitee.id)).accessToken));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(await statuses(app, t, bolaH), { cal: 'hit', feed: 'hit', roster: 'miss' }, 'accept: the roster only');
    const members = (await read(app, t, 'roster', bolaH)).res.body.members as Array<{ userId: string; name: string }>;
    assert.ok(members.some((m) => m.userId === invitee.id && m.name === 'Ife Invitee'), 'the new member is on the cached roster');
  });
});

describe('the 5 s window and the first 5 s of a process bypass the cache (caching.md)', () => {
  test('the writer reads past the cache, sees the write, and fills nothing; everyone else is not affected', async () => {
    const t = await setup();
    await warm(app, t, t.bolaH);
    const id = await publish(app, t, t.ownerH, 'Morning service', 9, 13, null);

    for (const kind of KINDS) {
      const mine = await read(app, t, kind, t.ownerH);
      assert.equal(mine.log.cache, 'bypass', `${kind}: the writer's read`);
      assert.equal(mine.log.dbRoute, 'marker', `${kind}: the primary, because of their own write`);
      assert.deepEqual(mine.commands, [], `${kind}: the cache was not touched, not even to look`);
      if (kind === 'cal') assert.ok(mine.res.body.shifts.some((s: { id: string }) => s.id === id), 'they see their own write at once');
    }
    // The bypassed reads filled nothing: the next reader still finds a cold cache for what the write replaced.
    assert.deepEqual(await statuses(app, t, t.bolaH), { cal: 'miss', feed: 'miss', roster: 'hit' });
  });

  test('a process younger than 5 s bypasses the cache for everyone', async () => {
    // Seed through the shared app first (the tokens and the data are valid for any app on the same shards), so the read comes within a second of the start.
    const t = await setup(app);
    const fresh = await startTeamsTestApp({ cache: { enabled: true } });
    try {
      const mine = await read(fresh, t, 'cal', t.bolaH);
      assert.equal(mine.log.cache, 'bypass');
      assert.equal(mine.log.dbRoute, 'startup');
      assert.deepEqual(mine.commands, []);
    } finally {
      await fresh.stop();
    }
  });
});

describe('a failed invalidation (caching.md test 5)', () => {
  test('the write succeeds, the failure is logged loudly, the writer still sees it, and another reader may see the old entry until its TTL', async () => {
    const tight = await startTeamsTestApp({ cache: { enabled: true, ttlSeconds: { cal: CAL_TTL } } });
    try {
      await sleep(5_300);
      await run(tight);
    } finally {
      await tight.stop();
    }
  });

  async function run(app: TeamsTestApp) {
    const t = await setup(app);
    await warm(app, t, t.bolaH);
    const warmedAt = Date.now();

    app.failCache((op, key) => (op === 'set' && key.endsWith(':gen') ? new Error('connection reset') : undefined));
    const id = await publish(app, t, t.ownerH, 'Morning service', 9, 13, null); // 201: the write is never blocked by the cache
    app.failCache(undefined);
    const failure = logsOf(app).filter((l) => l.msg === 'cache_invalidation_failed' && l.teamId === t.teamId);
    assert.equal(failure.length, 1);
    assert.equal(failure[0]!.level, 'error');

    const mine = await read(app, t, 'cal', t.ownerH);
    assert.equal(mine.log.cache, 'bypass');
    assert.ok(mine.res.body.shifts.some((s: { id: string }) => s.id === id), "the writer's reads within 5 s bypass the cache and see the write");

    // The failure starts a short cool-off, during which reads skip the cache and come from the database: fresh, if unplanned.
    const during = await read(app, t, 'cal', t.bolaH);
    assert.equal(during.log.cache, 'error');
    assert.ok(during.res.body.shifts.some((s: { id: string }) => s.id === id));

    // After the cool-off, another user is served the OLD entry: the documented worst case, at most one entry TTL.
    await sleep(5_300);
    const stale = await read(app, t, 'cal', t.bolaH);
    assert.equal(stale.log.cache, 'hit');
    assert.ok(!stale.res.body.shifts.some((s: { id: string }) => s.id === id), 'stale: the new shift is not in it');
    // The writer's window is over too, so the writer sees the same old entry now.
    assert.equal((await read(app, t, 'cal', t.ownerH)).log.cache, 'hit');

    // And the TTL ends it.
    await sleep(Math.max(0, warmedAt + CAL_TTL * 1000 + 600 - Date.now()));
    const fresh = await read(app, t, 'cal', t.bolaH);
    assert.equal(fresh.log.cache, 'miss');
    assert.ok(fresh.res.body.shifts.some((s: { id: string }) => s.id === id), 'by TTL expiry the entry is gone and the read is fresh');
  }
});

describe('what shapes the answer is in the key (caching.md test 6)', () => {
  test('feed pages with another limit, calendar views for another person, and later feed pages never share or reuse an entry', async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++) await publish(app, t, t.ownerH, `Shift ${i}`, 8 + i * 4, 10 + i * 4, i === 0 ? t.amara.id : t.bola.id);
    const feed = (query: string) => app.get(`/teams/${t.teamId}/activity${query}`, t.managerH);

    const one = await feed('?limit=1');
    const two = await feed('?limit=2');
    assert.equal(one.body.items.length, 1);
    assert.equal(two.body.items.length, 2);
    assert.ok(one.body.nextCursor && two.body.nextCursor);
    assert.notEqual(one.body.nextCursor, two.body.nextCursor, 'each page has its own cursor');
    assert.equal(lastGet(app).cache, 'miss');
    const oneAgain = await feed('?limit=1');
    assert.deepEqual(oneAgain.body, one.body, 'limit=1 hits its own entry and returns its own page');
    assert.equal(lastGet(app).cache, 'hit');
    assert.equal((await feed('?limit=2')).body.items.length, 2);

    // A later page is never cached: no cache field on its log line, and the cache is not asked at all.
    app.clearCacheCommands();
    const later = await feed(`?limit=1&cursor=${encodeURIComponent(one.body.nextCursor)}`);
    assert.equal(later.status, 200);
    assert.equal(lastGet(app).cache, undefined);
    assert.deepEqual(app.cacheCommands(), []);
    assert.notEqual(later.body.items[0].id, one.body.items[0].id);

    // The calendar: "mine" is personal, the whole team's is not, and they differ.
    const mineUrl = `${urls(t.teamId).cal}&mine=true`;
    const amaraMine = await app.get(mineUrl, t.amaraH);
    const bolaMine = await app.get(mineUrl, t.bolaH);
    const everyone = await app.get(urls(t.teamId).cal, t.amaraH);
    assert.equal(amaraMine.body.shifts.length, 1);
    assert.equal(bolaMine.body.shifts.length, 2);
    assert.equal(everyone.body.shifts.length, 3);
    assert.deepEqual((await app.get(mineUrl, t.amaraH)).body, amaraMine.body, "Amara's own view is still hers on the second read");
    assert.equal(lastGet(app).cache, 'hit');

    // One entry per (limit) and per (scope, range): the keys in Valkey say so.
    const keys = (await app.cacheEntries(t.teamId)).map((e) => e.key).filter((k) => !k.endsWith(':gen'));
    assert.equal(keys.filter((k) => k.includes(':feed:')).length, 2, 'two feed entries: limit 1 and limit 2');
    assert.equal(keys.filter((k) => k.includes(':cal:')).length, 3, 'three calendar entries: Amara, Bola, the team');
    assert.equal(new Set(keys).size, keys.length);
    await assertEveryKeyHasATtl(app, t.teamId);
  });
});

describe('a cache failure never fails a request (caching.md test 8)', () => {
  test('the cache cannot be reached: every read is answered from the database, one log line per outage, and it recovers by itself', async () => {
    const t = await setup();
    await publish(app, t, t.ownerH, 'Morning service', 9, 13, null);
    app.failCache(() => new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    for (const kind of KINDS) {
      const r = await read(app, t, kind, t.bolaH);
      assert.equal(r.log.cache, 'error', kind);
      assert.equal(r.res.status, 200);
    }
    assert.equal(logsOf(app).filter((l) => l.msg === 'cache_unavailable' && l.level === 'error').length >= 1, true);
    assert.equal(logsOf(app).slice(-10).filter((l) => l.msg === 'cache_unavailable').length <= 1, true, 'one line for the outage, not one per request');

    app.failCache(undefined);
    await sleep(5_300);
    assert.equal((await read(app, t, 'cal', t.bolaH)).log.cache, 'miss', 'back to normal once the cool-off is over');
    assert.ok(logsOf(app).some((l) => l.msg === 'cache_recovered'));
  });

  test('Valkey fully down: the feed returns 503 (the rate limiter fails closed, ADR 0022); the cache failing is not what stops the others', async () => {
    const down = await startTeamsTestApp({ deadValkey: true, cache: { enabled: true } });
    try {
      await sleep(5_300);
      const t = await setup(down);
      assert.equal((await down.get(urls(t.teamId).feed, t.bolaH)).status, 503);
      assert.equal((await down.get(urls(t.teamId).cal, t.bolaH)).status, 200, 'the calendar is answered from the database');
      assert.equal(lastGet(down).cache, 'error');
      assert.equal((await down.get(urls(t.teamId).roster, t.bolaH)).status, 200);
    } finally {
      await down.stop();
    }
  });
});

describe('what is never cached (caching.md test 9)', () => {
  test('sessions, permission checks, the team and its renewal, settings, swaps and single shifts never ask the cache anything', async () => {
    const t = await setup();
    const shiftId = await publish(app, t, t.ownerH, 'Morning service', 9, 13, t.amara.id);
    app.clearCacheCommands();

    // (The session check runs on every authenticated request below, and none of them reaches the cache.)
    assert.equal((await app.get('/teams', t.bolaH)).status, 200); // a user's teams
    assert.equal((await app.get(`/teams/${t.teamId}`, t.bolaH)).status, 200); // the team and its renewal state
    assert.equal((await app.get('/settings', t.bolaH)).status, 200); // settings (quiet hours decide pushes)
    assert.equal((await app.get(`/_test/teams/${t.teamId}/owner-manager-action`, t.bolaH)).status, 403); // a permission check: Staff refused
    assert.equal((await app.get(`/_test/teams/${t.teamId}/owner-manager-action`, t.ownerH)).status, 200); // and an Owner allowed
    assert.equal((await app.get(`/teams/${t.teamId}/swaps`, t.bolaH)).status, 200);
    assert.equal((await app.get(`/teams/${t.teamId}/shifts/${shiftId}`, t.bolaH)).status, 200);
    assert.equal((await app.get(`/teams/${t.teamId}/shifts/upcoming`, t.amaraH)).status, 200);

    assert.deepEqual(app.cacheCommands(), [], 'not one command reached the cache for any of them');
    // A role change takes effect on the very next request, because the role is read from the primary, never from a cached roster.
    await app.setRole(t.teamId, t.manager.id, 'staff');
    assert.equal((await app.get(`/_test/teams/${t.teamId}/owner-manager-action`, t.managerH)).status, 403);
    assert.deepEqual(app.cacheCommands(), []);
  });

  test('every key the cache ever writes is one of the three team kinds', async () => {
    const t = await setup();
    await warm(app, t, t.bolaH);
    for (const { key } of await app.cacheEntries(t.teamId)) {
      assert.match(key, new RegExp(`^cache:v1:team:${t.teamId}:(roster|cal|feed):`), key);
    }
  });
});

describe('the switch (caching.md test 10)', () => {
  test('with caching off nothing is read from or written to Valkey, and the log says off', async () => {
    const off = await startTeamsTestApp(); // the default: off
    try {
      await sleep(5_300);
      const t = await setup(off);
      await publish(off, t, t.ownerH, 'Morning service', 9, 13, null);
      for (const kind of KINDS) {
        const r = await read(off, t, kind, t.bolaH);
        assert.equal(r.log.cache, 'off', kind);
        assert.deepEqual(r.commands, [], kind);
      }
      assert.deepEqual(await off.cacheEntries(t.teamId), [], 'no cache:* key exists for the team');
      assert.deepEqual(off.cacheCommands(), []);
    } finally {
      await off.stop();
    }
  });

  test('cache OFF: the three reads go to the REPLICA (the k6 "before" run); cache ON: a miss reads the primary, a hit reads nothing', async () => {
    const off = await startTeamsTestApp({ replicas: true });
    const on = await startTeamsTestApp({ replicas: true, cache: { enabled: true } });
    try {
      await sleep(5_300);
      const a = await setup(off);
      const before = off.replicaQueries().length;
      const r = await read(off, a, 'cal', a.bolaH);
      assert.equal(r.log.cache, 'off');
      assert.equal(r.log.dbRoute, 'none', 'the routing function chose the replica');
      assert.ok(off.replicaQueries().length > before, 'and the replica was asked');

      const b = await setup(on);
      const mark = on.replicaQueries().length;
      const miss = await read(on, b, 'cal', b.bolaH);
      assert.equal(miss.log.cache, 'miss');
      assert.equal(miss.log.dbRoute, 'primary-required');
      const hit = await read(on, b, 'cal', b.bolaH);
      assert.equal(hit.log.cache, 'hit');
      assert.equal(on.replicaQueries().length, mark, 'with the cache on, the replica was not asked for the calendar at all: misses read the primary, hits read nothing');
    } finally {
      await off.stop();
      await on.stop();
    }
  });
});
