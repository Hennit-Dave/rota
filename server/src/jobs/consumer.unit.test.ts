import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startConsumerWatchdog, type Consumer } from './consumer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = 30; // shortened so the tests are fast; production uses PRODUCER_COMMAND_TIMEOUT_MS

type Behaviour = 'answers' | 'silent' | 'errors';

function fakeConsumer(opts: { status?: string; ping?: Behaviour; closeNeverFinishes?: boolean; closeGate?: Promise<void> } = {}) {
  const log = { pings: 0, closes: [] as Array<boolean | undefined>, disconnects: 0 };
  const consumer = {
    worker: {
      close: (force?: boolean) => {
        log.closes.push(force);
        if (opts.closeNeverFinishes) return new Promise<void>(() => {});
        return opts.closeGate ?? Promise.resolve();
      },
    },
    connection: {
      status: opts.status ?? 'ready',
      ping: () => {
        log.pings++;
        const b = opts.ping ?? 'answers';
        if (b === 'silent') return new Promise<string>(() => {});
        if (b === 'errors') return Promise.reject(new Error('NOAUTH Authentication required.'));
        return Promise.resolve('PONG');
      },
      disconnect: () => void log.disconnects++,
    },
  } as unknown as Consumer;
  return { consumer, log };
}

// intervalMs is huge so only probeNow() runs a probe: the tests drive the ticks themselves.
const IDLE = 3_600_000;

test('a probe that is answered changes nothing', async () => {
  const a = fakeConsumer({ ping: 'answers' });
  let rebuilds = 0;
  const dog = startConsumerWatchdog({ consumer: a.consumer, rebuild: () => (rebuilds++, fakeConsumer().consumer), intervalMs: IDLE, timeoutMs: TIMEOUT });
  assert.equal(await dog.probeNow(), 'ok');
  assert.equal(rebuilds, 0);
  assert.equal(dog.current(), a.consumer);
  await dog.stop();
});

test('silence on a ready connection rebuilds the consumer once and retires the old one', async () => {
  const old = fakeConsumer({ ping: 'silent' });
  const fresh = fakeConsumer();
  let rebuilds = 0;
  const dog = startConsumerWatchdog({ consumer: old.consumer, rebuild: () => (rebuilds++, fresh.consumer), intervalMs: IDLE, timeoutMs: TIMEOUT });
  assert.equal(await dog.probeNow(), 'rebuilt');
  assert.equal(rebuilds, 1);
  assert.equal(dog.current(), fresh.consumer, 'shutdown must now close the new consumer');
  assert.deepEqual(old.log.closes, [true], 'the old worker is force-closed (it does not wait for its job)');
  assert.equal(old.log.disconnects, 1, 'and its connection is disconnected hard');
  assert.equal(await dog.probeNow(), 'ok', 'the next probe is on the new consumer');
  await dog.stop();
});

test('a connection that is not ready is left to ioredis: no probe, no rebuild', async () => {
  const a = fakeConsumer({ status: 'reconnecting', ping: 'silent' });
  let rebuilds = 0;
  const dog = startConsumerWatchdog({ consumer: a.consumer, rebuild: () => (rebuilds++, fakeConsumer().consumer), intervalMs: IDLE, timeoutMs: TIMEOUT });
  assert.equal(await dog.probeNow(), 'skipped_not_ready');
  assert.equal(a.log.pings, 0);
  assert.equal(rebuilds, 0);
  await dog.stop();
});

test('a PING answered with an error is not silence: no rebuild', async () => {
  const a = fakeConsumer({ ping: 'errors' });
  let rebuilds = 0;
  const dog = startConsumerWatchdog({ consumer: a.consumer, rebuild: () => (rebuilds++, fakeConsumer().consumer), intervalMs: IDLE, timeoutMs: TIMEOUT });
  assert.equal(await dog.probeNow(), 'probe_error');
  assert.equal(rebuilds, 0);
  await dog.stop();
});

test('GUARD: while one rebuild is in progress no other probe or rebuild can start', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // The old worker's close() is held open, so the first rebuild stays "in progress" (bounded only by the teardown timeout).
  const old = fakeConsumer({ ping: 'silent', closeGate: gate });
  let rebuilds = 0;
  const dog = startConsumerWatchdog({
    consumer: old.consumer,
    rebuild: () => (rebuilds++, fakeConsumer({ ping: 'silent' }).consumer),
    intervalMs: IDLE,
    timeoutMs: 1_000, // longer than this test, so the teardown is still running when the other ticks arrive
  });
  const first = dog.probeNow();
  await sleep(1_050); // past the probe timeout: the rebuild has started and is waiting on the old worker's close()
  assert.equal(rebuilds, 1);
  const others = await Promise.all([dog.probeNow(), dog.probeNow(), dog.probeNow()]);
  assert.deepEqual(others, ['skipped_busy', 'skipped_busy', 'skipped_busy']);
  assert.equal(rebuilds, 1, 'no second rebuild while one is in progress');
  assert.equal(old.log.pings, 1, 'and no overlapping probe either');
  release();
  assert.equal(await first, 'rebuilt');
  assert.equal(rebuilds, 1);
  await dog.stop();
});

test('an old worker whose close() never finishes cannot hold the rebuild: teardown is bounded and the connection is cut', async () => {
  const old = fakeConsumer({ ping: 'silent', closeNeverFinishes: true });
  const dog = startConsumerWatchdog({ consumer: old.consumer, rebuild: () => fakeConsumer().consumer, intervalMs: IDLE, timeoutMs: TIMEOUT });
  const started = Date.now();
  assert.equal(await dog.probeNow(), 'rebuilt');
  assert.ok(Date.now() - started < 1_000, 'probe timeout plus teardown timeout, not forever');
  assert.equal(old.log.disconnects, 1);
  await dog.stop();
});

test('the timer probes on its interval, and stop() ends it and waits for a probe in progress', async () => {
  const a = fakeConsumer({ ping: 'answers' });
  const dog = startConsumerWatchdog({ consumer: a.consumer, rebuild: () => fakeConsumer().consumer, intervalMs: 20, timeoutMs: TIMEOUT });
  await sleep(110);
  assert.ok(a.log.pings >= 3, `expected repeated probes, got ${a.log.pings}`);
  await dog.stop();
  const after = a.log.pings;
  await sleep(80);
  assert.equal(a.log.pings, after, 'no probes after stop()');
  assert.equal(await dog.probeNow(), 'skipped_stopped');
});

test('a connection stuck in the ioredis handshake (`connect`) is rebuilt on the second probe in a row, not the first', async () => {
  const stuck = fakeConsumer({ status: 'connect', ping: 'silent' });
  let rebuilds = 0;
  const dog = startConsumerWatchdog({ consumer: stuck.consumer, rebuild: () => (rebuilds++, fakeConsumer().consumer), intervalMs: IDLE, timeoutMs: TIMEOUT });
  assert.equal(await dog.probeNow(), 'skipped_connecting', 'a handshake in progress is normal for a moment');
  assert.equal(rebuilds, 0);
  assert.equal(await dog.probeNow(), 'rebuilt', 'still in the handshake a whole interval later: it will never finish');
  assert.equal(rebuilds, 1);
  assert.equal(stuck.log.pings, 0, 'no PING is sent on a connection that is not ready');
  await dog.stop();
});

test('a handshake that finishes between probes does not count: connect, then ready, then connect again starts the count over', async () => {
  const c = fakeConsumer({ status: 'connect', ping: 'answers' });
  let rebuilds = 0;
  const dog = startConsumerWatchdog({ consumer: c.consumer, rebuild: () => (rebuilds++, fakeConsumer().consumer), intervalMs: IDLE, timeoutMs: TIMEOUT });
  assert.equal(await dog.probeNow(), 'skipped_connecting');
  (c.consumer.connection as unknown as { status: string }).status = 'ready';
  assert.equal(await dog.probeNow(), 'ok');
  (c.consumer.connection as unknown as { status: string }).status = 'connect';
  assert.equal(await dog.probeNow(), 'skipped_connecting', 'the earlier sighting was forgotten');
  assert.equal(rebuilds, 0);
  await dog.stop();
});
