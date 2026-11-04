import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '../http/logger.js';
import type { LogFields } from '../http/logger.js';
import { loadCacheConfig, type CacheConfig } from './config.js';
import { entryKey, filtersHash, generationKey } from './keys.js';
import { COOL_OFF_MS, createTeamCache, type CacheRedis } from './store.js';

// The cache module against a fake Valkey and a fake clock: nothing real is touched. The same behaviours are proved again against the real Valkey, over real
// HTTP, in cache.http.integration.test.ts.
const TEAM = '00000000-0000-4000-8000-0000000000aa';
const USER = '11111111-1111-4111-8111-111111111111';

class FakeRedis implements CacheRedis {
  data = new Map<string, { value: string; expiresAt: number; ttl: number }>();
  commands: string[] = [];
  status = 'ready';
  disconnected = 0;
  infoText = 'used_memory:1000\r\nmaxmemory:100000\r\n';
  fail: (op: 'get' | 'set' | 'info', key: string) => Error | undefined = () => undefined;
  constructor(private now: () => number) {}
  private live(key: string) {
    const e = this.data.get(key);
    return e && e.expiresAt > this.now() ? e : undefined;
  }
  async get(key: string) {
    this.commands.push(`get ${key}`);
    const f = this.fail('get', key);
    if (f) throw f;
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, _mode: 'EX', seconds: number, nx?: 'NX') {
    this.commands.push(`set ${key}${nx ? ' NX' : ''}`);
    const f = this.fail('set', key);
    if (f) throw f;
    if (nx && this.live(key)) return null;
    this.data.set(key, { value, expiresAt: this.now() + seconds * 1000, ttl: seconds });
    return 'OK';
  }
  async info() {
    this.commands.push('info memory');
    const f = this.fail('info', '');
    if (f) throw f;
    return this.infoText;
  }
  disconnect() {
    this.disconnected++;
  }
}

function setup(overrides: Partial<CacheConfig> = {}, newGeneration?: () => string) {
  let t = 1_000_000;
  const redis = new FakeRedis(() => t);
  const logs: Array<{ level: string; msg: string; fields?: LogFields }> = [];
  const logger: Logger = {
    info: (msg, fields) => void logs.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => void logs.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => void logs.push({ level: 'error', msg, fields }),
  };
  const config = { ...loadCacheConfig({}), ...overrides };
  let n = 0;
  const gens = newGeneration ?? (() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`);
  const cache = createTeamCache({ redis, config, logger, now: () => t, newGeneration: gens, statsEveryMs: null });
  const feed = <T>(load: (o: { primary: boolean }) => Promise<T>, extra: { bypass?: boolean; params?: string[] } = {}) =>
    cache.get({ kind: 'feed', teamId: TEAM, scope: 'team', params: extra.params ?? ['20', 'abc'], bypass: extra.bypass ?? false, load });
  return { cache, redis, logs, config, feed, advance: (ms: number) => void (t += ms) };
}

const page = (label: string) => ({ items: [label], nextCursor: null });

describe('config (caching.md: every TTL is config; the approved values are the defaults)', () => {
  it('defaults are the values Dave approved on 2026-11-04', () => {
    assert.deepEqual(loadCacheConfig({}), {
      enabled: true,
      ttlSeconds: { feed: 30, cal: 30, roster: 60 },
      generationTtlSeconds: 600,
      memoryLimitPercent: 70,
      memoryCheckSeconds: 30,
    });
  });
  it('reads overrides, and refuses a value it cannot trust', () => {
    assert.equal(loadCacheConfig({ CACHE_ENABLED: 'false' }).enabled, false);
    assert.equal(loadCacheConfig({ CACHE_TTL_FEED_SECONDS: '5' }).ttlSeconds.feed, 5);
    assert.throws(() => loadCacheConfig({ CACHE_ENABLED: 'yes' }), /CACHE_ENABLED must be "true" or "false"/);
    assert.throws(() => loadCacheConfig({ CACHE_TTL_FEED_SECONDS: '0' }), /CACHE_TTL_FEED_SECONDS/);
    assert.throws(() => loadCacheConfig({ CACHE_TTL_ROSTER_SECONDS: '1.5' }), /CACHE_TTL_ROSTER_SECONDS/);
    assert.throws(() => loadCacheConfig({ CACHE_MEMORY_LIMIT_PERCENT: '100' }), /1 to 99/);
    assert.throws(() => loadCacheConfig({ CACHE_GENERATION_TTL_SECONDS: '60' }), /longer than every entry TTL/);
  });
});

describe('keys: every input that shapes the response is in the key (caching.md test 6)', () => {
  const G = '00000000-0000-4000-8000-000000000001';
  it('feed requests with a different limit, filters or scope never share an entry', () => {
    const keys = new Set([
      entryKey(TEAM, 'feed', G, 'team', ['20', filtersHash({})]),
      entryKey(TEAM, 'feed', G, 'team', ['10', filtersHash({})]),
      entryKey(TEAM, 'feed', G, 'team', ['20', filtersHash({ kind: 'shift_created' })]),
      entryKey(TEAM, 'feed', G, `user:${USER}`, ['20', filtersHash({})]),
      entryKey(TEAM, 'cal', G, 'team', ['20', filtersHash({})]),
    ]);
    assert.equal(keys.size, 5);
  });
  it('the filter hash ignores the order the filters were sent in, and is shown a different filter value as a different key', () => {
    assert.equal(filtersHash({ a: 1, b: 2 }), filtersHash({ b: 2, a: 1 }));
    assert.notEqual(filtersHash({ a: 1 }), filtersHash({ a: 2 }));
  });
  it('the key shape matches caching.md', () => {
    assert.equal(generationKey(TEAM, 'roster'), `cache:v1:team:${TEAM}:roster:gen`);
    assert.equal(entryKey(TEAM, 'cal', G, `user:${USER}`, ['1', '2']), `cache:v1:team:${TEAM}:cal:${G}:user:${USER}:1:2`);
  });
  it('a value that could change what the key means is refused', () => {
    assert.throws(() => entryKey(TEAM, 'feed', G, 'team', ['a:b']), /parameter/);
    assert.throws(() => entryKey(TEAM, 'feed', G, 'team', ['a b']), /parameter/);
    assert.throws(() => entryKey('not-a-uuid', 'feed', G, 'team', []), /teamId/);
    assert.throws(() => entryKey(TEAM, 'feed', 'x', 'team', []), /generation/);
    assert.throws(() => entryKey(TEAM, 'feed', G, 'user:nope' as never, []), /scope user/);
    assert.throws(() => entryKey(TEAM, 'feed', G, 'everyone' as never, []), /scope/);
  });
});

describe('cache-aside (caching.md tests 1, 3, 4, 5, 7)', () => {
  it('HIT AND MISS: the first read misses and fills from the PRIMARY; the second hits and reads no database', async () => {
    const s = setup();
    const loads: boolean[] = [];
    const load = async (o: { primary: boolean }) => {
      loads.push(o.primary);
      return page('A');
    };
    const first = await s.feed(load);
    assert.deepEqual(first, { value: page('A'), status: 'miss' });
    const second = await s.feed(load);
    assert.deepEqual(second, { value: page('A'), status: 'hit' });
    assert.deepEqual(loads, [true], 'one database read, and it was a primary read');
  });

  it('every entry and generation is written WITH a TTL, from config (test 7)', async () => {
    const s = setup();
    await s.feed(async () => page('A'));
    await s.cache.get({ kind: 'cal', teamId: TEAM, scope: 'team', params: ['1', '2'], bypass: false, load: async () => ({ shifts: [] }) });
    await s.cache.get({ kind: 'roster', teamId: TEAM, scope: 'team', params: [], bypass: false, load: async () => ({ members: [] }) });
    await s.cache.invalidate(TEAM, ['feed', 'cal', 'roster']);
    const ttlOf = (part: string) => [...s.redis.data].filter(([k]) => k.includes(part) && !k.endsWith(':gen')).map(([, v]) => v.ttl);
    assert.deepEqual(ttlOf(':feed:'), [30]);
    assert.deepEqual(ttlOf(':cal:'), [30]);
    assert.deepEqual(ttlOf(':roster:'), [60]);
    for (const [key, v] of s.redis.data) {
      assert.ok(Number.isFinite(v.expiresAt) && v.ttl > 0, `${key} has a TTL`);
      if (key.endsWith(':gen')) assert.equal(v.ttl, 600, 'a generation lives longer than any entry');
    }
  });

  it('a corrupt entry is not an answer: it is a miss and gets replaced', async () => {
    const s = setup();
    await s.feed(async () => page('A'));
    const entry = [...s.redis.data].find(([k]) => k.includes(':feed:') && !k.endsWith(':gen'))!;
    entry[1].value = '{not json';
    assert.equal((await s.feed(async () => page('B'))).status, 'miss');
    assert.equal((await s.feed(async () => page('C'))).status, 'hit');
  });

  it('BYPASS (the 5 s window, the first 5 s of a process): the cache is not read, not filled, and the routing function decides', async () => {
    const s = setup();
    const loads: boolean[] = [];
    const res = await s.feed(async (o) => (loads.push(o.primary), page('A')), { bypass: true });
    assert.equal(res.status, 'bypass');
    assert.deepEqual(loads, [false], 'primary:false means "route as usual": the window itself sends the user to the primary');
    assert.deepEqual(s.redis.commands, [], 'Valkey was not touched at all');
    assert.equal((await s.feed(async () => page('B'))).status, 'miss', 'the bypassed read filled nothing');
  });

  it('INVALIDATION: the next read after a write misses and sees the change (test 2, store level)', async () => {
    const s = setup();
    await s.feed(async () => page('old'));
    assert.equal((await s.feed(async () => page('x'))).status, 'hit');
    await s.cache.invalidate(TEAM, ['feed']);
    assert.deepEqual(await s.feed(async () => page('new')), { value: page('new'), status: 'miss' });
  });

  it('CONCURRENT STALE FILL: a fill that read the old data and lands after an invalidation is never served (test 3)', async () => {
    const s = setup();
    let finishOldRead!: () => void;
    const oldRead = new Promise<void>((r) => (finishOldRead = r));
    // The fill captures the generation, then starts reading the database... and is slow.
    const slow = s.feed(async () => {
      await oldRead;
      return page('OLD');
    });
    await new Promise((r) => setImmediate(r));
    await s.cache.invalidate(TEAM, ['feed']); // a write commits and replaces the generation meanwhile
    finishOldRead(); // the old read finishes and writes its (old) result, under the OLD generation
    assert.equal((await slow).status, 'miss');
    assert.deepEqual(await s.feed(async () => page('FRESH')), { value: page('FRESH'), status: 'miss' }, 'nobody looks up the old generation, so the stale fill is never read');
  });

  it('GENERATION LOSS: deleting the generation key while entries exist gives a NEW random generation that matches none of them (test 4)', async () => {
    const s = setup();
    await s.feed(async () => page('A'));
    const genKey = [...s.redis.data.keys()].find((k) => k.endsWith(':feed:gen'))!;
    const oldGen = s.redis.data.get(genKey)!.value;
    assert.equal((await s.feed(async () => page('x'))).status, 'hit');
    s.redis.data.delete(genKey); // lost
    assert.deepEqual(await s.feed(async () => page('B')), { value: page('B'), status: 'miss' });
    assert.notEqual(s.redis.data.get(genKey)!.value, oldGen);
  });

  it('an EXPIRED generation can never bring an old generation back: the next one is a new random UUID, and entries filled under the old one are unreachable', async () => {
    // Real random generations (no deterministic stand-in): this is the property that matters.
    const s = setup({}, undefined);
    const real = setup({}, () => crypto.randomUUID());
    await real.feed(async () => page('A'));
    const genKey = [...real.redis.data.keys()].find((k) => k.endsWith(':feed:gen'))!;
    const first = real.redis.data.get(genKey)!.value;
    // Let the generation expire. (An entry normally dies first; here one is kept alive to prove it could not be reached anyway.)
    const entry = [...real.redis.data].find(([k]) => k.includes(':feed:') && !k.endsWith(':gen'))!;
    real.advance(601_000);
    entry[1].expiresAt = Number.POSITIVE_INFINITY;
    assert.equal(real.redis.data.get(genKey)!.expiresAt <= 1_000_000 + 601_000, true, 'the generation has expired');
    assert.deepEqual(await real.feed(async () => page('B')), { value: page('B'), status: 'miss' }, 'the live old entry is not reachable');
    const second = real.redis.data.get(genKey)!.value;
    assert.notEqual(second, first);
    assert.match(second, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a random (v4) UUID, not a counter or a timestamp');
    // 2,000 fresh generations: no repeats.
    const seen = new Set(Array.from({ length: 2_000 }, () => crypto.randomUUID()));
    assert.equal(seen.size, 2_000);
    void s;
  });

  it('two requests that both find no generation end up on the SAME one (SET NX, then read back)', async () => {
    const s = setup();
    const a = s.feed(async () => page('A'));
    const b = s.feed(async () => page('B'));
    await Promise.all([a, b]);
    const gens = [...s.redis.data].filter(([k]) => k.endsWith(':feed:gen'));
    assert.equal(gens.length, 1);
    assert.equal(s.redis.commands.filter((c) => c.endsWith(':feed:gen NX')).length, 2, 'both tried to create it; only one took');
  });

  it('FAILED INVALIDATION: the write is not blocked or undone, the failure is logged loudly, another reader may see the old entry, and it expires by TTL (test 5)', async () => {
    const s = setup();
    await s.feed(async () => page('old'));
    s.redis.fail = (op, key) => (op === 'set' && key.endsWith(':gen') ? new Error('connection reset') : undefined);
    await assert.doesNotReject(s.cache.invalidate(TEAM, ['feed']));
    assert.equal(s.cache.stats().invalidationFailures, 1);
    assert.ok(s.logs.some((l) => l.level === 'error' && l.msg === 'cache_invalidation_failed' && l.fields?.teamId === TEAM));
    s.redis.fail = () => undefined;
    // The failure itself starts the cool-off, so for a few seconds reads skip the cache and go to the database (which is correct, if unplanned).
    assert.deepEqual(await s.feed(async () => page('NEW')), { value: page('NEW'), status: 'error' });
    // Once the cool-off ends the old entry is still there, and is served: this is the documented worst case, at most one entry TTL (30 s).
    s.advance(COOL_OFF_MS + 1);
    assert.equal((await s.feed(async () => page('NEW'))).value.items[0], 'old', 'stale, for at most one entry TTL');
    s.advance(30_000 - COOL_OFF_MS);
    assert.equal((await s.feed(async () => page('NEW'))).value.items[0], 'NEW', 'and the TTL ends it');
  });

  it('an invalidation for a bad team ID is a logged failure, never a thrown error', async () => {
    const s = setup();
    await assert.doesNotReject(s.cache.invalidate('not-a-uuid', ['cal']));
    assert.equal(s.cache.stats().invalidationFailures, 1);
  });
});

describe('the switch (caching.md test 10)', () => {
  it('with caching off nothing is read from or written to Valkey, not even by an invalidation', async () => {
    const s = setup({ enabled: false });
    const loads: boolean[] = [];
    const res = await s.feed(async (o) => (loads.push(o.primary), page('A')));
    assert.deepEqual(res, { value: page('A'), status: 'off' });
    assert.deepEqual(loads, [false], 'the read goes the way it always did: the routing function decides');
    await s.cache.invalidate(TEAM, ['feed', 'cal', 'roster']);
    assert.deepEqual(s.redis.commands, []);
    assert.equal(s.redis.data.size, 0);
  });
});

describe('a cache failure never fails a request (caching.md test 8, store level)', () => {
  it('the cache cannot be reached: the answer comes from the database, one log line says so, and reads skip the cache for a few seconds', async () => {
    const s = setup();
    s.redis.fail = () => new Error('connect ECONNREFUSED');
    const first = await s.feed(async () => page('DB'));
    assert.deepEqual(first, { value: page('DB'), status: 'error' });
    const before = s.redis.commands.length;
    const second = await s.feed(async () => page('DB'));
    assert.equal(second.status, 'error');
    assert.equal(s.redis.commands.length, before, 'during the cool-off the cache is not even tried');
    assert.equal(s.logs.filter((l) => l.msg === 'cache_unavailable').length, 1, 'one line per outage');

    s.redis.fail = () => undefined;
    s.advance(COOL_OFF_MS + 1);
    assert.equal((await s.feed(async () => page('DB'))).status, 'miss', 'back to normal');
    assert.ok(s.logs.some((l) => l.msg === 'cache_recovered'));
  });

  it('a command that got no answer on a connection that still says ready replaces the connection (issue #39)', async () => {
    const s = setup();
    s.redis.fail = () => new Error('Command timed out');
    await s.feed(async () => page('DB'));
    assert.equal(s.redis.disconnected, 1);
  });

  it('a failed FILL still answers the request', async () => {
    const s = setup();
    s.redis.fail = (op, key) => (op === 'set' && !key.endsWith(':gen') && !key.endsWith(':gen NX') ? new Error('connection reset') : undefined);
    assert.deepEqual(await s.feed(async () => page('DB')), { value: page('DB'), status: 'miss' });
  });

  it('Valkey REFUSING a write because memory is full (noeviction: "OOM command not allowed") is caught, counted, and stops fills for a while', async () => {
    const s = setup();
    s.redis.fail = (op, key) => (op === 'set' && !key.endsWith(':gen') ? new Error("OOM command not allowed when used memory > 'maxmemory'.") : undefined);
    assert.deepEqual(await s.feed(async () => page('DB'), { params: ['1', 'a'] }), { value: page('DB'), status: 'miss' });
    assert.equal(s.cache.stats().writesRejected, 1);
    assert.ok(s.logs.some((l) => l.msg === 'cache_write_rejected'));
    assert.ok(!s.logs.some((l) => l.msg === 'cache_unavailable'), 'a refused write is not an outage');
    const sets = s.redis.commands.filter((c) => c.startsWith('set') && !c.includes(':gen')).length;
    await s.feed(async () => page('DB'), { params: ['2', 'b'] });
    assert.equal(s.redis.commands.filter((c) => c.startsWith('set') && !c.includes(':gen')).length, sets, 'no second attempt while blocked');
    assert.equal(s.cache.stats().fillsSkipped, 1);
  });

  it('an invalidation Valkey refuses for memory is a loud logged failure, not an outage and not an error for the writer', async () => {
    const s = setup();
    s.redis.fail = (op) => (op === 'set' ? new Error("OOM command not allowed when used memory > 'maxmemory'.") : undefined);
    await assert.doesNotReject(s.cache.invalidate(TEAM, ['cal']));
    assert.equal(s.cache.stats().invalidationFailures, 1);
    assert.ok(!s.logs.some((l) => l.msg === 'cache_unavailable'));
  });
});

describe('the memory guard: stop filling above 70% used, checked at most every 30 s', () => {
  it('above the limit nothing is filled; reads still work and the check is not repeated inside 30 s', async () => {
    const s = setup();
    s.redis.infoText = 'used_memory:80000\r\nmaxmemory:100000\r\n'; // 80%
    assert.equal((await s.feed(async () => page('A'), { params: ['1', 'a'] })).status, 'miss');
    assert.equal((await s.feed(async () => page('A'), { params: ['2', 'b'] })).status, 'miss');
    assert.equal(s.cache.stats().fillsSkipped, 2);
    assert.equal(s.redis.commands.filter((c) => c === 'info memory').length, 1, 'checked once, not per request');
    assert.equal([...s.redis.data.keys()].filter((k) => !k.endsWith(':gen')).length, 0, 'nothing was stored');
    assert.ok(s.logs.some((l) => l.msg === 'cache_filling_stopped'));
  });

  it('after 30 s with room again, filling resumes', async () => {
    const s = setup();
    s.redis.infoText = 'used_memory:80000\r\nmaxmemory:100000\r\n';
    await s.feed(async () => page('A'));
    s.redis.infoText = 'used_memory:60000\r\nmaxmemory:100000\r\n'; // 60%
    s.advance(30_001);
    await s.feed(async () => page('A'));
    assert.equal((await s.feed(async () => page('A'))).status, 'hit');
    assert.ok(s.logs.some((l) => l.msg === 'cache_filling_resumed'));
  });

  it('exactly at the limit counts as full; no maxmemory (0) means nothing to measure against', async () => {
    const full = setup();
    full.redis.infoText = 'used_memory:70000\r\nmaxmemory:100000\r\n';
    await full.feed(async () => page('A'));
    assert.equal(full.cache.stats().fillsSkipped, 1);
    const unlimited = setup();
    unlimited.redis.infoText = 'used_memory:999999999\r\nmaxmemory:0\r\n';
    await unlimited.feed(async () => page('A'));
    assert.equal(unlimited.cache.stats().fillsSkipped, 0);
  });

  it('when the memory cannot be read, it does not fill', async () => {
    const s = setup();
    s.redis.infoText = 'nonsense';
    await s.feed(async () => page('A'));
    assert.equal(s.cache.stats().fillsSkipped, 1);
  });
});

describe('the stats line (every 60 s in production)', () => {
  it('writes the counters and the hit rate for the window, then starts a new window; a quiet window writes nothing', async () => {
    const s = setup();
    await s.feed(async () => page('A')); // miss
    await s.feed(async () => page('A')); // hit
    await s.feed(async () => page('A')); // hit
    await s.feed(async () => page('A'), { bypass: true });
    s.advance(60_000);
    s.cache.flushStats();
    const line = s.logs.find((l) => l.msg === 'cache_stats')!;
    assert.deepEqual(line.fields, {
      windowSeconds: 60,
      cacheHits: 2,
      cacheMisses: 1,
      cacheBypassed: 1,
      cacheOff: 0,
      cacheErrors: 0,
      cacheFillsSkipped: 0,
      cacheWritesRejected: 0,
      cacheInvalidations: 0,
      cacheInvalidationFailures: 0,
      cacheHitRate: 0.667,
    });
    const before = s.logs.length;
    s.cache.flushStats();
    assert.equal(s.logs.length, before, 'nothing happened, so nothing is logged');
  });
});
