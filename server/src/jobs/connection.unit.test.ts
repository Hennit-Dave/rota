import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnqueueTimeoutError, isStaleConnectionSignal, recycleIfStale, type RecyclableConnection } from './connection.js';

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
