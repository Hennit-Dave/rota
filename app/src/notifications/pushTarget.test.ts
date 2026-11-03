import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePushData, routeFor } from './pushTarget';

const teamId = '3f2b8c1e-5d4a-4f6b-9c7d-0a1b2c3d4e5f';
const good = { v: 1, type: 'billing', moment: 'renewal_failed', teamId };

test('a known shape opens the billing hub for that team, for both billing moments', () => {
  assert.deepEqual(parsePushData(good), { type: 'billing', moment: 'renewal_failed', teamId });
  assert.deepEqual(parsePushData({ ...good, moment: 'renewal_read_only' }), { type: 'billing', moment: 'renewal_read_only', teamId });
  assert.equal(routeFor(parsePushData(good)!), '/billing');
});

test('anything that is not exactly a known shape opens nothing', () => {
  const bad: unknown[] = [
    null,
    undefined,
    'billing',
    [],
    {},
    { ...good, v: 2 },
    { ...good, v: '1' },
    { ...good, type: 'swap_updates' },
    { ...good, moment: 'renewal_paid' },
    { ...good, moment: undefined },
    { ...good, teamId: 'not-a-uuid' },
    { ...good, teamId: undefined },
    { ...good, teamId: `${teamId}/../../account` },
  ];
  for (const raw of bad) assert.equal(parsePushData(raw), null, JSON.stringify(raw));
});

test('a path or any other extra field in the data is ignored: the screen is chosen by the app, never by the notification', () => {
  const t = parsePushData({ ...good, path: '/account/sessions', url: 'https://evil.example', screen: '/shift/new' });
  assert.deepEqual(t, { type: 'billing', moment: 'renewal_failed', teamId });
  assert.equal(routeFor(t!), '/billing');
});

test('the team id is normalised to lower case so it matches the app\'s own ids', () => {
  assert.equal(parsePushData({ ...good, teamId: teamId.toUpperCase() })!.teamId, teamId);
});
