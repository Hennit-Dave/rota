import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secondsUntilUtcMidnight } from './routes.js';

test('the app-wide invite cap resets at 00:00 UTC, the same moment Resend\'s daily quota does', () => {
  assert.equal(secondsUntilUtcMidnight(new Date('2026-10-23T00:00:00.000Z')), 86_400);
  assert.equal(secondsUntilUtcMidnight(new Date('2026-10-23T23:59:59.000Z')), 1);
  assert.equal(secondsUntilUtcMidnight(new Date('2026-10-23T12:00:00.000Z')), 43_200);
  assert.equal(secondsUntilUtcMidnight(new Date('2026-12-31T23:00:00.000Z')), 3_600, 'across a year boundary');
  assert.equal(secondsUntilUtcMidnight(new Date('2026-10-23T23:59:59.900Z')), 1, 'never zero');
});
