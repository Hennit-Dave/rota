import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createReconciler, decideJobAction, type ReconcileTrigger } from './reconcile.js';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test('decideJobAction: missing adds, live states leave, failed and completed need a new generation', () => {
  assert.equal(decideJobAction('unknown'), 'add');
  for (const s of ['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'] as const) {
    assert.equal(decideJobAction(s), 'leave', s);
  }
  assert.equal(decideJobAction('failed'), 'new_generation');
  assert.equal(decideJobAction('completed'), 'new_generation');
});

test('scheduler: runs once at startup and again on every interval, as "timed"', async () => {
  const seen: ReconcileTrigger[] = [];
  const r = createReconciler(async (t) => void seen.push(t), { intervalMs: 30 });
  await sleep(110);
  await r.stop();
  assert.equal(seen[0], 'startup');
  assert.ok(seen.filter((t) => t === 'timed').length >= 2, `expected timed runs, got ${seen.join(',')}`);
});

test('scheduler: passes never overlap, and a timed tick during a pass is dropped', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const r = createReconciler(
    async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(80);
      active--;
    },
    { intervalMs: 20 },
  );
  await sleep(60);
  await r.stop();
  assert.equal(maxActive, 1);
  assert.equal(runs, 1, 'timed ticks during the startup pass must be dropped, not queued');
});

test('scheduler: a reconnect that arrives mid-pass runs once straight after it', async () => {
  const source = new EventEmitter();
  const seen: ReconcileTrigger[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const r = createReconciler(
    async (t) => {
      seen.push(t);
      if (seen.length === 1) await gate; // hold the startup pass open
    },
    { intervalMs: 60_000, reconnectSource: source as any },
  );
  await sleep(10);
  source.emit('close');
  source.emit('ready'); // reconnect while the startup pass is still running
  source.emit('ready'); // a second ready without a close is not a reconnect
  release();
  await sleep(30);
  await r.stop();
  assert.deepEqual(seen, ['startup', 'reconnect']);
});

test('scheduler: the first ready (initial connect) is not a reconnect', async () => {
  const source = new EventEmitter();
  const seen: ReconcileTrigger[] = [];
  const r = createReconciler(async (t) => void seen.push(t), {
    intervalMs: 60_000,
    reconnectSource: source as any,
  });
  await sleep(10);
  source.emit('ready');
  await sleep(10);
  await r.stop();
  assert.deepEqual(seen, ['startup']);
});

test('scheduler: a failing pass is logged and does not stop the schedule', async () => {
  let runs = 0;
  const r = createReconciler(
    async () => {
      runs++;
      throw new Error('boom postgresql://user:secret@host/db');
    },
    { intervalMs: 20 },
  );
  await sleep(90);
  await r.stop();
  assert.ok(runs >= 2, `schedule must survive a throwing pass, runs=${runs}`);
});

test('scheduler: stop() waits for the pass in flight and removes its listeners', async () => {
  const source = new EventEmitter();
  let finished = false;
  const r = createReconciler(
    async () => {
      await sleep(40);
      finished = true;
    },
    { intervalMs: 60_000, reconnectSource: source as any },
  );
  await sleep(5);
  await r.stop();
  assert.equal(finished, true);
  assert.equal(source.listenerCount('close'), 0);
  assert.equal(source.listenerCount('ready'), 0);
});
