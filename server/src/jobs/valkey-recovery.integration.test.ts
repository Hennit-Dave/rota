import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createLogger } from '../http/logger.js';
import { installPostRoutes, installPreRoutes } from '../http/pipeline.js';
import { createRateLimiter, rateLimit, RateLimiterUnavailableError, type RateLimiter } from '../ratelimit/limiter.js';
import { createProducerConnection, recycleIfStale } from './connection.js';
import { createConsumer, startConsumerWatchdog, type Consumer } from './consumer.js';
import { addWorkJob, createWorkQueue } from './queue.js';
import { BULLMQ_LOCK_DURATION_MS, BULLMQ_MAX_STALLED_COUNT, BULLMQ_STALLED_INTERVAL_MS } from './config.js';
import {
  localValkeyAvailable,
  startCuttableProxy,
  startLocalValkey,
  type CuttableProxy,
  type LocalValkey,
} from './valkey.testkit.js';

// Issue #39: the API's Valkey clients must recover from a lost connection with no restart.
// DISPOSABLE LOCAL VALKEY ONLY (jobs.md): the server is started here on 127.0.0.1 and nothing reads VALKEY_URL, so the shared
// Aiven instance is never touched. Needs `valkey-server` on PATH, or LOCAL_VALKEY_BIN. Without it the tests skip, with this reason.
const available = await localValkeyAvailable();
const skip = available ? false : 'valkey-server not found: install Valkey or set LOCAL_VALKEY_BIN';

// A budget for "recovers on its own", not a setting: the failing request takes the 2 s command timeout, ioredis may take up to
// its own 2 s disconnectTimeout to give up a half-open socket, then it reconnects.
const RECOVERY_BUDGET_MS = 20_000;

let valkey: LocalValkey;
let proxy: CuttableProxy;
const opened: Redis[] = [];

before(async () => {
  if (!available) return;
  valkey = await startLocalValkey();
  proxy = await startCuttableProxy(valkey.port);
});

after(async () => {
  for (const r of opened) r.disconnect();
  if (!available) return;
  await proxy.close();
  await valkey.dispose();
});

function connect(): Redis {
  const redis = createProducerConnection(proxy.url);
  redis.on('error', () => {}); // expected during an outage; keep the output quiet
  opened.push(redis);
  return redis;
}

async function eventually<T>(what: string, attempt: () => Promise<T>, budgetMs = RECOVERY_BUDGET_MS): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < budgetMs) {
    try {
      return { value: await attempt(), ms: Date.now() - started };
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`${what}: still failing after ${budgetMs} ms. Last error: ${String(last)}`);
}

const rule = () => ({ name: 'login_ip', subject: `ip-${randomUUID()}`, max: 100, windowSeconds: 60 });

/** The limiter wired as the API wires it: a timeout on a ready connection replaces the connection. */
function wiredLimiter(redis: Redis, counter: { recycled: number }): RateLimiter {
  return createRateLimiter(redis, {
    prefix: `rl-test-${randomUUID()}`,
    onUnavailable: (cause) => {
      if (recycleIfStale(redis, cause)) counter.recycled++;
    },
  });
}

test('half-open connection: the limiter fails closed, then works again on the same connection with no restart', { skip }, async () => {
  const redis = connect();
  await redis.connect();
  const counter = { recycled: 0 };
  const limiter = wiredLimiter(redis, counter);

  assert.equal((await limiter.consume(rule())).allowed, true, 'works before the outage');

  proxy.halfOpen();
  const started = Date.now();
  await assert.rejects(() => limiter.consume(rule()), RateLimiterUnavailableError, 'fails closed during the outage');
  assert.ok(Date.now() - started < 8000, 'fails within a bounded time');
  assert.equal(redis.status, 'ready', 'ioredis never noticed: this is the half-open case, not a clean drop');
  assert.ok(counter.recycled >= 1, 'a timeout on a ready connection replaces it');

  proxy.restore();
  const { value, ms } = await eventually('limiter after the network came back', () => limiter.consume(rule()));
  assert.equal(value.allowed, true);
  assert.ok(ms < RECOVERY_BUDGET_MS);
  console.log(`  half-open: the same connection object served requests again ${ms} ms after the network came back`);
});

test('an outage that outlasts the first recycle: the replacement connects into the dead path, and the producer still recovers', { skip }, async () => {
  const redis = connect();
  await redis.connect();
  const limiter = wiredLimiter(redis, { recycled: 0 });

  assert.equal((await limiter.consume(rule())).allowed, true);
  proxy.halfOpen();
  const outage = Date.now();
  let recycles = 0;
  while (Date.now() - outage < 8_000) {
    // Every attempt fails closed. The first one replaces the connection; the replacement is opened while the path is still dead.
    await assert.rejects(() => limiter.consume(rule()), RateLimiterUnavailableError);
    if (redis.status === 'ready') recycles++;
    await new Promise((r) => setTimeout(r, 300));
  }
  proxy.restore();
  const { value, ms } = await eventually('limiter after a long outage', () => limiter.consume(rule()));
  assert.equal(value.allowed, true);
  console.log(`  long outage: the same connection object served requests again ${ms} ms after the network came back`);
});

test('without the recovery the same half-open connection stays dead (this is the bug in #39)', { skip }, async () => {
  const redis = connect();
  await redis.connect();
  const limiter = createRateLimiter(redis, { prefix: `rl-test-${randomUUID()}` }); // no onUnavailable hook: the old behaviour

  assert.equal((await limiter.consume(rule())).allowed, true);
  proxy.halfOpen();
  await assert.rejects(() => limiter.consume(rule()), RateLimiterUnavailableError);
  proxy.restore();
  await assert.rejects(
    () => eventually('limiter without recovery', () => limiter.consume(rule()), 9_000),
    /still failing/,
    'without the recovery the connection never comes back',
  );
});

test('clean drop: ioredis reconnects by itself and nothing is recycled', { skip }, async () => {
  const redis = connect();
  await redis.connect();
  const counter = { recycled: 0 };
  const limiter = wiredLimiter(redis, counter);

  assert.equal((await limiter.consume(rule())).allowed, true);
  proxy.cut();
  const { value } = await eventually('limiter after a clean drop', () => limiter.consume(rule()), 10_000);
  assert.equal(value.allowed, true);
  assert.equal(counter.recycled, 0, 'a reset is not a timeout; the recovery must not fire');
});

test('Valkey process stopped and started: 503s while it is down, the same connection works when it is back', { skip }, async () => {
  const redis = connect();
  await redis.connect();
  const limiter = wiredLimiter(redis, { recycled: 0 });

  assert.equal((await limiter.consume(rule())).allowed, true);
  await valkey.stop();
  await assert.rejects(() => limiter.consume(rule()), RateLimiterUnavailableError, 'fails closed while Valkey is down');
  await valkey.start();
  const { value } = await eventually('limiter after Valkey restarted', () => limiter.consume(rule()), 10_000);
  assert.equal(value.allowed, true);
});

test('HTTP: a rate-limited route answers 503 during a half-open outage and 200 again, same server, no restart', { skip }, async () => {
  const redis = connect();
  await redis.connect();
  const limiter = wiredLimiter(redis, { recycled: 0 });

  const logger = createLogger(() => {});
  const app = express();
  installPreRoutes(app, logger);
  let handlerRuns = 0;
  app.post('/login-ish', rateLimit(limiter, logger, () => [rule()]), (_req, res) => {
    handlerRuns++;
    res.json({ ok: true });
  });
  installPostRoutes(app, logger);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login-ish`;
  const status = async () => (await fetch(url, { method: 'POST' })).status;

  try {
    assert.equal(await status(), 200);
    proxy.halfOpen();
    assert.equal(await status(), 503);
    const during = handlerRuns;
    assert.equal(await status(), 503);
    assert.equal(handlerRuns, during, 'the handler never runs while the limiter cannot decide');
    proxy.restore();
    const { value } = await eventually('route after the network came back', async () => {
      const s = await status();
      if (s !== 200) throw new Error(`HTTP ${s}`);
      return s;
    });
    assert.equal(value, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('queue producer: a half-open connection fails the enqueue (the row stays for the sweep), then enqueues work again', { skip }, async () => {
  const redis = connect();
  const queue = createWorkQueue(`recovery-test-${randomUUID()}`, redis);
  const row = () => ({ id: randomUUID(), kind: 'test', generation: 1, runAt: new Date() });

  try {
    await addWorkJob(queue, row(), 'A');

    proxy.halfOpen();
    await assert.rejects(() => addWorkJob(queue, row(), 'A'), /timed out/i, 'the enqueue fails within its time budget');
    proxy.restore();

    const again = row();
    const { ms } = await eventually('enqueue after the network came back', () => addWorkJob(queue, again, 'A'));
    const direct = createProducerConnection(`redis://127.0.0.1:${valkey.port}`);
    opened.push(direct);
    await direct.connect();
    assert.ok(await direct.exists(`bull:${queue.name}:work-${again.id}-1`), 'the job is really in Valkey');
    console.log(`  queue producer: enqueue worked again ${ms} ms after the network came back`);
  } finally {
    await queue.close();
  }
});


// The worker's consumer. The proxy cuts the WHOLE network path, so the worker's connection and the blocking connection BullMQ
// duplicates from it die together: the realistic case (a laptop sleeping, a NAT forgetting the mapping).
// The processor is trivial; what is under test is the connection layer, built exactly as the worker builds it (createConsumer).
function consumerHarness() {
  const queueName = `consumer-test-${randomUUID()}`;
  const processed = new Set<string>();
  const makeWorker = (connection: Redis) =>
    new Worker(
      queueName,
      async (job) => {
        processed.add(job.data.name as string);
      },
      {
        connection,
        concurrency: 1,
        lockDuration: BULLMQ_LOCK_DURATION_MS,
        stalledInterval: BULLMQ_STALLED_INTERVAL_MS,
        maxStalledCount: BULLMQ_MAX_STALLED_COUNT,
      },
    );
  const attach = (w: Worker) => w.on('error', () => {}); // expected while the network is cut
  const direct = createProducerConnection(`redis://127.0.0.1:${valkey.port}`); // the producer's own path, never cut
  opened.push(direct);
  const queue = new Queue(queueName, { connection: direct });
  const add = (name: string) => queue.add('t', { name }, { jobId: name });
  const consumed = async (name: string, budgetMs: number) => {
    try {
      await eventually(`consume ${name}`, async () => {
        if (!processed.has(name)) throw new Error('not yet');
      }, budgetMs);
      return true;
    } catch {
      return false;
    }
  };
  const start = async (): Promise<Consumer> => {
    const consumer = createConsumer({ url: proxy.url, makeWorker, attach });
    await consumer.worker.waitUntilReady();
    return consumer;
  };
  return { processed, add, consumed, start, makeWorker, attach, close: () => queue.close() };
}

test('worker consumer: with the watchdog, the whole path cut and restored, the same process consumes again (jobs queued during and after)', { skip }, async () => {
  const h = consumerHarness();
  const first = await h.start();
  const rebuilds: string[] = [];
  const dog = startConsumerWatchdog({
    consumer: first,
    rebuild: () => (rebuilds.push('rebuilt'), createConsumer({ url: proxy.url, makeWorker: h.makeWorker, attach: h.attach })),
    intervalMs: 1_000, // shortened from the 15 s default so the test is quick; the default is BULLMQ_STALLED_INTERVAL_MS
  });
  try {
    await h.add('baseline');
    assert.equal(await h.consumed('baseline', 5_000), true, 'consumes before the outage');

    proxy.halfOpen();
    await new Promise((r) => setTimeout(r, 500));
    await h.add('during-outage');
    await new Promise((r) => setTimeout(r, 6_000)); // long enough for at least one probe to fail and a rebuild to happen
    assert.equal(h.processed.has('during-outage'), false, 'nothing is consumed while the network is cut');
    assert.ok(rebuilds.length >= 1, 'the watchdog noticed the silence and rebuilt the consumer');

    proxy.restore();
    await h.add('after-network-back');
    assert.equal(await h.consumed('during-outage', RECOVERY_BUDGET_MS), true, 'the job queued during the outage is consumed');
    assert.equal(await h.consumed('after-network-back', 5_000), true, 'and so is the one queued after');
    assert.notEqual(dog.current(), first, 'the consumer in use is the rebuilt one');
  } finally {
    await dog.stop();
    for (const c of new Set([first, dog.current()])) {
      c.worker.close(true).catch(() => {});
      c.connection.disconnect();
    }
    await h.close();
  }
});

test('worker consumer: without the watchdog the same worker never consumes again (this is the bug in #39)', { skip }, async () => {
  const h = consumerHarness();
  const only = await h.start();
  try {
    await h.add('baseline');
    assert.equal(await h.consumed('baseline', 5_000), true);

    proxy.halfOpen();
    await new Promise((r) => setTimeout(r, 500));
    await h.add('during-outage');
    proxy.restore();
    await h.add('after-network-back');
    assert.equal(await h.consumed('during-outage', 10_000), false, 'still not consumed 10 s after the network is back');
    assert.equal(h.processed.has('after-network-back'), false);
  } finally {
    only.worker.close(true).catch(() => {});
    only.connection.disconnect();
    await h.close();
  }
});
