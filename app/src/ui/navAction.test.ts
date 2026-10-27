import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navAction } from './navAction';

test('Schedule is the root: any tab goes back to it by popping, so Back from a tab lands on Schedule, not outside the app', () => {
  assert.equal(navAction('team', 'schedule'), 'dismissTo');
  assert.equal(navAction('settings', 'schedule'), 'dismissTo');
});

test('a tab opened from Schedule is pushed on top of it, so Back returns to Schedule', () => {
  assert.equal(navAction('schedule', 'team'), 'push');
  assert.equal(navAction('schedule', 'settings'), 'push');
});

test('moving between two non-root tabs replaces, so the stack never grows with every tab visited', () => {
  assert.equal(navAction('team', 'settings'), 'replace');
  assert.equal(navAction('settings', 'team'), 'replace');
});
