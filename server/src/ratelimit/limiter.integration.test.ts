import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import type { Redis } from 'ioredis';
import { createProducerConnection } from '../jobs/connection.js';
import { createLogger } from '../http/logger.js';
import { installPostRoutes, installPreRoutes } from '../http/pipeline.js';
import { createRateLimiter, rateLimit, RateLimiterUnavailableError } from './limiter.js';

// Real Valkey (Aiven). Every test uses this run's unique prefix and records each key the limiter touches, then
// deletes exactly those keys. No wildcard DEL, no FLUSHALL (jobs.md: destructive tests only on disposable data).
const prefix = `rl-test-${randomUUID()}`;
const touched = new Set<string>();
let redis: Redis;
const limiter = () => createRateLimiter(redis, { prefix, onKey: (k) => touched.add(k) });

before(async () => {
  redis = createProducerConnection();
  await redis.connect();
});

after(async () => {
  if (touched.size > 0) await redis.del(...touched);
  // Verify cleanup by scanning for this run's unique prefix only. Reading, not deleting.
  let cursor = '0';
  const leftovers: string[] = [];
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 200);
    cursor = next;
    leftovers.push(...keys);
  } while (cursor !== '0');
  redis.disconnect();
  assert.deepEqual(leftovers, [], 'test left rate-limit keys behind');
});

test('real Valkey: counts, denies after max, and every key has a TTL within its window', async () => {
  const l = limiter();
  const rule = { name: 'login_email', subject: `a-${randomUUID()}@example.com`, max: 3, windowSeconds: 60 };
  const allowed = [];
  for (let i = 0; i < 5; i++) allowed.push((await l.consume(rule)).allowed);
  assert.deepEqual(allowed, [true, true, true, false, false]);

  for (const key of touched) {
    const ttl = await redis.ttl(key);
    assert.ok(ttl > 0 && ttl <= 60, `key ${key} must have a TTL in (0, 60], got ${ttl}`);
  }
  const r = await l.consume(rule);
  assert.ok(r.retryAfterSeconds >= 1 && r.retryAfterSeconds <= 60);
});

test('real Valkey: different subjects have independent counters', async () => {
  const l = limiter();
  const a = { name: 'login_ip', subject: `ip-${randomUUID()}`, max: 1, windowSeconds: 60 };
  const b = { name: 'login_ip', subject: `ip-${randomUUID()}`, max: 1, windowSeconds: 60 };
  assert.equal((await l.consume(a)).allowed, true);
  assert.equal((await l.consume(a)).allowed, false);
  assert.equal((await l.consume(b)).allowed, true);
});

test('real Valkey: 25 simultaneous attempts are counted atomically, exactly max are allowed', async () => {
  const l = limiter();
  const rule = { name: 'refresh_ip', subject: `ip-${randomUUID()}`, max: 10, windowSeconds: 60 };
  const results = await Promise.all(Array.from({ length: 25 }, () => l.consume(rule)));
  assert.equal(results.filter((r) => r.allowed).length, 10);
  assert.deepEqual([...new Set(results.map((r) => r.count))].sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
});

test('real Valkey: the window resets after it passes', async () => {
  const l = limiter();
  const rule = { name: 'register_ip', subject: `ip-${randomUUID()}`, max: 1, windowSeconds: 2 };
  assert.equal((await l.consume(rule)).allowed, true);
  assert.equal((await l.consume(rule)).allowed, false);
  await new Promise((r) => setTimeout(r, 2300));
  const after = await l.consume(rule);
  assert.equal(after.allowed, true);
  assert.equal(after.count, 1);
});

test('Valkey unreachable: the limiter throws within a bounded time, and the route answers 503 (fails closed)', async () => {
  const dead = createProducerConnection('redis://127.0.0.1:1');
  dead.on('error', () => {}); // expected; keep the test output quiet
  const l = createRateLimiter(dead, { prefix });
  const started = Date.now();
  await assert.rejects(() => l.consume({ name: 'login_ip', subject: 'x', max: 1, windowSeconds: 60 }), RateLimiterUnavailableError);
  assert.ok(Date.now() - started < 8000, 'must not hang when Valkey is down');

  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const app = express();
  installPreRoutes(app, logger);
  let handlerRan = false;
  app.post('/login-ish', rateLimit(l, logger, () => [{ name: 'login_ip', subject: 'x', max: 1, windowSeconds: 60 }]), (_req, res) => {
    handlerRan = true;
    res.json({ ok: true });
  });
  installPostRoutes(app, logger);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/login-ish`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'service_unavailable');
    assert.equal(handlerRan, false, 'the handler must never run when the limiter cannot decide');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    dead.disconnect();
  }
});
