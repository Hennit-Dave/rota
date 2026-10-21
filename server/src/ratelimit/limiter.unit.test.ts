import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientIp, createRateLimiter, rateLimitKey, RateLimiterUnavailableError, type RedisLike } from './limiter.js';

/** An in-memory stand-in that behaves like SET NX EX / INCR / PTTL, so the limiter's logic can be tested. */
function fakeRedis(opts: { failExec?: boolean; pttlOverride?: number; execResult?: unknown } = {}) {
  const store = new Map<string, { n: number; ttlMs: number | null }>();
  const expireCalls: Array<[string, number]> = [];
  const redis: RedisLike = {
    pipeline() {
      const ops: Array<() => unknown> = [];
      const p = {
        set(key: string, _v: number, _ex: 'EX', seconds: number, _nx: 'NX') {
          ops.push(() => {
            if (!store.has(key)) store.set(key, { n: 0, ttlMs: seconds * 1000 });
            return 'OK';
          });
          return p;
        },
        incr(key: string) {
          ops.push(() => ++store.get(key)!.n);
          return p;
        },
        pttl(key: string) {
          ops.push(() => (opts.pttlOverride !== undefined ? opts.pttlOverride : (store.get(key)!.ttlMs ?? -1)));
          return p;
        },
        async exec() {
          if (opts.failExec) throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
          if (opts.execResult !== undefined) return opts.execResult as never;
          return ops.map((op) => [null, op()] as [Error | null, unknown]);
        },
      };
      return p;
    },
    async expire(key, seconds) {
      expireCalls.push([key, seconds]);
      return 1;
    },
  };
  return { redis, store, expireCalls };
}

const rule = { name: 'login_email', subject: 'a@b.co', max: 3, windowSeconds: 900 };

test('counts attempts, allows up to max, then denies with a retry time', async () => {
  const { redis } = fakeRedis();
  const limiter = createRateLimiter(redis);
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await limiter.consume(rule));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false, false]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0, 0, 0]);
  assert.equal(results[3]!.retryAfterSeconds, 900);
});

test('the key is hashed: no raw subject in it, same subject same key, different rule different key', () => {
  const k1 = rateLimitKey('rl:v1', 'login_email', 'victim@example.com');
  assert.ok(!k1.includes('victim') && !k1.includes('@'));
  assert.equal(k1, rateLimitKey('rl:v1', 'login_email', 'victim@example.com'));
  assert.notEqual(k1, rateLimitKey('rl:v1', 'login_ip', 'victim@example.com'));
  assert.match(k1, /^rl:v1:login_email:[0-9a-f]{64}$/);
});

test('every key it touches is reported (for exact-key test cleanup) and created with a TTL', async () => {
  const { redis, store } = fakeRedis();
  const seen: string[] = [];
  const limiter = createRateLimiter(redis, { prefix: 'rl-test-x', onKey: (k) => seen.push(k) });
  await limiter.consume(rule);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.startsWith('rl-test-x:'));
  assert.equal(store.get(seen[0]!)!.ttlMs, 900_000);
});

test('a key with no TTL (PTTL -1) or one that vanished (-2) is given an expiry, never left immortal', async () => {
  for (const pttl of [-1, -2]) {
    const { redis, expireCalls } = fakeRedis({ pttlOverride: pttl });
    const r = await createRateLimiter(redis).consume(rule);
    assert.equal(expireCalls.length, 1, `pttl ${pttl}`);
    assert.equal(expireCalls[0]![1], 900);
    assert.equal(r.retryAfterSeconds, 900);
  }
});

test('Valkey failing or answering oddly throws RateLimiterUnavailableError (so the route fails closed)', async () => {
  await assert.rejects(() => createRateLimiter(fakeRedis({ failExec: true }).redis).consume(rule), RateLimiterUnavailableError);
  await assert.rejects(
    () => createRateLimiter(fakeRedis({ execResult: [[new Error('OOM command not allowed when used memory > maxmemory'), null], [null, 1], [null, 1000]] }).redis).consume(rule),
    RateLimiterUnavailableError,
  );
  await assert.rejects(() => createRateLimiter(fakeRedis({ execResult: null }).redis).consume(rule), RateLimiterUnavailableError);
});

test('clientIp uses the socket peer address (never a header) and folds IPv4-mapped IPv6', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '::ffff:203.0.113.9' } } as never), '203.0.113.9');
  assert.equal(clientIp({ socket: { remoteAddress: '2001:db8::1' } } as never), '2001:db8::1');
  assert.equal(clientIp({ socket: { remoteAddress: undefined } } as never), 'unknown');
});
