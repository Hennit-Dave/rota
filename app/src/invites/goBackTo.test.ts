import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goBackTo, type ReturnHref, type ReturnRouter } from './goBackTo';

function fakeRouter(canGoBack: boolean) {
  const calls: string[] = [];
  const router: ReturnRouter = {
    canGoBack: () => canGoBack,
    dismissTo: (href: ReturnHref) => void calls.push(`dismissTo ${href}`),
    replace: (href: ReturnHref) => void calls.push(`replace ${href}`),
  };
  return { router, calls };
}

test('a screen is behind the invitation (opened over Home): pop back to it, never replace (that would add a second Home)', () => {
  const { router, calls } = fakeRouter(true);
  assert.equal(goBackTo(router, '/'), 'popped');
  assert.deepEqual(calls, ['dismissTo /']);
});

test('opened cold (the invitation is the only screen): nothing to pop to, so it replaces itself', () => {
  const { router, calls } = fakeRouter(false);
  assert.equal(goBackTo(router, '/'), 'replaced');
  assert.deepEqual(calls, ['replace /']);
});

test('the same two cases for the signed-out destination, the login screen', () => {
  const over = fakeRouter(true);
  assert.equal(goBackTo(over.router, '/login'), 'popped');
  assert.deepEqual(over.calls, ['dismissTo /login']);
  const cold = fakeRouter(false);
  assert.equal(goBackTo(cold.router, '/login'), 'replaced');
  assert.deepEqual(cold.calls, ['replace /login']);
});

test('exactly one navigation per call, so a button can never leave two entries', () => {
  for (const back of [true, false]) {
    const { router, calls } = fakeRouter(back);
    goBackTo(router, '/');
    assert.equal(calls.length, 1);
  }
});
