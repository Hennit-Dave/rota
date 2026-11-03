import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { loadPushConfig } from './config.js';
import { EXPO_TOKEN } from './devices.js';
import { ESSENTIAL_MOMENTS, MOMENT_TYPE, PUSH_MOMENTS, pushDataFor, pushEventPayload, pushPayload } from './message.js';

test('the phone receives a version, a type, a moment and a team id: no path, no amount, no text from the user', () => {
  const teamId = randomUUID();
  const data = pushDataFor({ moment: 'renewal_failed', teamId });
  assert.deepEqual(data, { v: 1, type: 'billing', moment: 'renewal_failed', teamId });
  assert.deepEqual(Object.keys(data).sort(), ['moment', 'teamId', 'type', 'v']);
});

test('both failed-renewal moments are billing pushes and both are essential (skip the notifyBilling toggle only); no shift or swap moment is essential', () => {
  for (const m of ['renewal_failed', 'renewal_read_only'] as const) {
    assert.equal(MOMENT_TYPE[m], 'billing');
    assert.equal(ESSENTIAL_MOMENTS.has(m), true);
  }
  for (const m of PUSH_MOMENTS.filter((x) => !x.startsWith('renewal_'))) {
    assert.equal(ESSENTIAL_MOMENTS.has(m), false, `${m}: the person's switch for that type applies`);
  }
});

test('payload schemas are strict: an unknown key or a missing recipient is refused', () => {
  const base = { moment: 'renewal_failed', teamId: randomUUID(), recipients: [randomUUID()], title: 'a', body: 'b' };
  assert.equal(pushEventPayload.safeParse(base).success, true);
  assert.equal(pushEventPayload.safeParse({ ...base, path: '/billing' }).success, false, 'no path field exists');
  assert.equal(pushEventPayload.safeParse({ ...base, recipients: [] }).success, false);
  assert.equal(pushEventPayload.safeParse({ ...base, moment: 'shift_moved' }).success, false, 'an unknown moment is refused');
  const push = { dedupeKey: 'k', eventRowId: randomUUID(), userId: randomUUID(), teamId: randomUUID(), teamTimeZone: 'UTC', moment: 'renewal_failed', title: 'a', body: 'b' };
  assert.equal(pushPayload.safeParse(push).success, true);
  assert.equal(pushPayload.safeParse({ ...push, extra: 1 }).success, false);
});

test('only Expo token shapes are accepted', () => {
  assert.equal(EXPO_TOKEN.test('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true);
  assert.equal(EXPO_TOKEN.test('ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true);
  for (const bad of ['', 'ExponentPushToken[]', 'ExponentPushToken[a', 'fcm-token-123', 'ExponentPushToken[a]x', "ExponentPushToken[a]'; DROP TABLE users;--", 'ExponentPushToken[' + 'a'.repeat(201) + ']']) {
    assert.equal(EXPO_TOKEN.test(bad), false, bad.slice(0, 40));
  }
});

test('push settings: defaults, the 15-minute receipt delay is Expo\'s advice, and bad values stop the worker', () => {
  assert.deepEqual(loadPushConfig({}), { sendTimeoutMs: 10_000, receiptDelayMs: 15 * 60_000 });
  assert.equal(loadPushConfig({ PUSH_SEND_TIMEOUT_MS: '5000' }).sendTimeoutMs, 5000);
  assert.throws(() => loadPushConfig({ PUSH_SEND_TIMEOUT_MS: '0' }), /PUSH_SEND_TIMEOUT_MS/);
  assert.throws(() => loadPushConfig({ PUSH_SEND_TIMEOUT_MS: 'ten' }), /PUSH_SEND_TIMEOUT_MS/);
  assert.throws(() => loadPushConfig({ PUSH_RECEIPT_DELAY_MINUTES: '1441' }), /PUSH_RECEIPT_DELAY_MINUTES/);
});
