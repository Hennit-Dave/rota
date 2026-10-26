import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLatch } from './latch';

test('three taps before anything re-renders: only the first gets through', () => {
  const latch = createLatch();
  const runs: number[] = [];
  for (const n of [1, 2, 3]) if (latch.tryAcquire()) runs.push(n);
  assert.deepEqual(runs, [1]);
  assert.equal(latch.held, true);
});

test('after the request finishes (success or failure) the next tap works again', () => {
  const latch = createLatch();
  assert.equal(latch.tryAcquire(), true);
  assert.equal(latch.tryAcquire(), false);
  latch.release();
  assert.equal(latch.held, false);
  assert.equal(latch.tryAcquire(), true);
});

test('releasing a latch nobody holds is harmless, and two latches are independent', () => {
  const a = createLatch();
  const b = createLatch();
  a.release();
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), true);
});
