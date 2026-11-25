import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnqueueTimeoutError, isStaleConnectionSignal, recycleIfStale, startKeepAlive, type RecyclableConnection } from './connection.js';

function fakeConnection(status = 'ready') {
  const calls: Array<boolean | undefined> = [];
  const closeListeners: Array<() => void> = [];
  const conn: RecyclableConnection & { status: string } = {
    status,
    disconnect: (reconnect) => void calls.push(reconnect),
    once: (_event, listener) => void closeListeners.push(listener),
  };
  return { conn, calls, close: () => closeListeners.splice(0).forEach((l) => l()) };
}

test('isStaleConnectionSignal: only "no answer" counts, never an answer that is an error', () => {
  assert.equal(isStaleConnectionSignal(new Error('Command timed out')), true);
  assert.equal(isStaleConnectionSignal(new EnqueueTimeoutError(2000)), true);
  assert.equal(isStaleConnectionSignal(new Error('OOM command not allowed when used memory > maxmemory.')), false, 'noeviction rejection');
  assert.equal(isStaleConnectionSignal(new Error('Connection is closed.')), false, 'ioredis already knows');
  assert.equal(isStaleConnectionSignal('Command timed out'), false, 'not an Error');
  assert.equal(isStaleConnectionSignal(undefined), false);
});

test('EnqueueTimeoutError keeps the message the logs and tests already know', () => {
  assert.equal(new EnqueueTimeoutError(2000).message, 'Valkey enqueue timed out after 2000ms');
});

test('recycleIfStale: a timeout on a ready connection starts one reconnect (disconnect(true))', () => {
  const { conn, calls } = fakeConnection('ready');
  assert.equal(recycleIfStale(conn, new Error('Command timed out')), true);
  assert.deepEqual(calls, [true]);
});

test('recycleIfStale: a burst of timeouts starts one replacement, and another once the old socket has closed', () => {
  const { conn, calls, close } = fakeConnection('ready');
  assert.equal(recycleIfStale(conn, new Error('Command timed out')), true);
  assert.equal(recycleIfStale(conn, new Error('Command timed out')), false);
  assert.equal(recycleIfStale(conn, new EnqueueTimeoutError(2000)), false);
  assert.equal(calls.length, 1);
  close();
  assert.equal(recycleIfStale(conn, new Error('Command timed out')), true);
  assert.equal(calls.length, 2);
});

test('recycleIfStale: does nothing when the connection is not ready, the failure is not a timeout, or there is no connection', () => {
  const reconnecting = fakeConnection('reconnecting');
  assert.equal(recycleIfStale(reconnecting.conn, new Error('Command timed out')), false);
  assert.deepEqual(reconnecting.calls, []);

  const ready = fakeConnection('ready');
  assert.equal(recycleIfStale(ready.conn, new Error('OOM command not allowed when used memory > maxmemory.')), false);
  assert.deepEqual(ready.calls, []);

  assert.equal(recycleIfStale(undefined, new Error('Command timed out')), false);
  assert.equal(recycleIfStale(null, new Error('Command timed out')), false);
});

// Keep-alive (ADR 0041, issue #79). A fake connection and mocked timers: no Valkey, no waiting.
function fakeKeepAliveConnection(status: string, reply: () => Promise<unknown> = async () => 'PONG') {
  let pings = 0;
  const disconnects: Array<boolean | undefined> = [];
  const listeners = new Map<string, Array<() => void>>();
  const conn = {
    status,
    ping: () => {
      pings++;
      return reply();
    },
    disconnect: (reconnect?: boolean) => void disconnects.push(reconnect),
    once: (event: string, listener: () => void) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
  };
  return {
    conn,
    pings: () => pings,
    disconnects,
    emit: (event: string) => (listeners.get(event) ?? []).splice(0).forEach((l) => l()),
  };
}

/** Let the PING's promise settle after a timer tick. */
const settle = () => new Promise((r) => setImmediate(r));

test('keep-alive: one PING per interval while the connection is ready', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = fakeKeepAliveConnection('ready');
  const stop = startKeepAlive(fake.conn, 1_000);
  t.mock.timers.tick(999);
  assert.equal(fake.pings(), 0, 'nothing before the first interval');
  t.mock.timers.tick(1);
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(1_000);
  assert.equal(fake.pings(), 3);
  stop();
});

test('keep-alive: sends nothing on a connection that is not ready, and never opens one', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // `wait` is a lazy connection nobody has opened yet: the fake has no connect(), so opening it would throw.
  for (const status of ['wait', 'connecting', 'connect', 'reconnecting', 'close', 'end']) {
    const fake = fakeKeepAliveConnection(status);
    const stop = startKeepAlive(fake.conn, 1_000);
    t.mock.timers.tick(5_000);
    assert.equal(fake.pings(), 0, `status ${status}`);
    stop();
  }
});

test('keep-alive: a PING with no reply on a ready connection replaces the connection once (issue #39 half-open)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(console, 'warn', () => {});
  const fake = fakeKeepAliveConnection('ready', async () => {
    throw new Error('Command timed out');
  });
  const stop = startKeepAlive(fake.conn, 1_000);
  t.mock.timers.tick(1_000);
  await settle();
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(fake.disconnects, [true], 'one replacement, even though two PINGs went unanswered before the old socket closed');
  stop();
});

test('keep-alive: a PING answered with an error changes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = fakeKeepAliveConnection('ready', async () => {
    throw new Error('OOM command not allowed when used memory > maxmemory.');
  });
  const stop = startKeepAlive(fake.conn, 1_000);
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(fake.pings(), 1);
  assert.deepEqual(fake.disconnects, []);
  stop();
});

test('keep-alive: stops when the connection ends for good, and when told to', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ended = fakeKeepAliveConnection('ready');
  startKeepAlive(ended.conn, 1_000);
  t.mock.timers.tick(1_000);
  ended.emit('end');
  t.mock.timers.tick(5_000);
  assert.equal(ended.pings(), 1, 'no PING after `end`');

  const stopped = fakeKeepAliveConnection('ready');
  const stop = startKeepAlive(stopped.conn, 1_000);
  stop();
  t.mock.timers.tick(5_000);
  assert.equal(stopped.pings(), 0);
});
