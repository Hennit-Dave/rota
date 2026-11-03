import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePushData, routeFor, PUSH_MOMENTS } from './pushTarget';

const teamId = '3f2b8c1e-5d4a-4f6b-9c7d-0a1b2c3d4e5f';
const shiftId = '7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const swapId = '11112222-3333-4444-8555-666677778888';
const billing = { v: 1, type: 'billing', moment: 'renewal_failed', teamId };
const shift = { v: 1, type: 'shift_changes', moment: 'shift_updated', teamId, shiftId };
const swap = { v: 1, type: 'swap_updates', moment: 'swap_requested', teamId, swapId };

test('billing opens the billing hub, for both billing moments', () => {
  assert.deepEqual(parsePushData(billing), { type: 'billing', moment: 'renewal_failed', teamId });
  assert.deepEqual(parsePushData({ ...billing, moment: 'renewal_read_only' }), { type: 'billing', moment: 'renewal_read_only', teamId });
  assert.equal(routeFor(parsePushData(billing)!), '/billing');
});

test('a shift change opens that shift, and a deleted shift (which no longer exists) opens the schedule', () => {
  for (const moment of ['shift_created', 'shift_updated'] as const) {
    const t = parsePushData({ ...shift, moment })!;
    assert.deepEqual(t, { type: 'shift_changes', moment, teamId, shiftId });
    assert.deepEqual(routeFor(t), { pathname: '/shift/[shiftId]', params: { shiftId } });
  }
  assert.equal(routeFor(parsePushData({ ...shift, moment: 'shift_deleted' })!), '/');
});

test('a swap event opens that swap, for all three swap moments', () => {
  for (const moment of ['swap_requested', 'swap_approved', 'swap_rejected'] as const) {
    const t = parsePushData({ ...swap, moment })!;
    assert.deepEqual(t, { type: 'swap_updates', moment, teamId, swapId });
    assert.deepEqual(routeFor(t), { pathname: '/swaps/[swapId]', params: { swapId } });
  }
});

test('every moment the server can send is understood, and every one has a route', () => {
  assert.equal(PUSH_MOMENTS.length, 8);
  const sample: Record<string, object> = { billing: { teamId }, shift_changes: { teamId, shiftId }, swap_updates: { teamId, swapId } };
  const typeOf = (m: string) => (m.startsWith('renewal_') ? 'billing' : m.startsWith('shift_') ? 'shift_changes' : 'swap_updates');
  for (const moment of PUSH_MOMENTS) {
    const type = typeOf(moment);
    const t = parsePushData({ v: 1, type, moment, ...sample[type] });
    assert.ok(t, moment);
    assert.ok(routeFor(t!), moment);
  }
});

test('anything that is not exactly a known shape opens nothing', () => {
  const bad: unknown[] = [
    null, undefined, 'billing', [], {},
    { ...billing, v: 2 }, { ...billing, v: '1' },
    { ...billing, type: 'something_else' }, { ...billing, moment: 'renewal_paid' }, { ...billing, moment: undefined },
    { ...billing, teamId: 'not-a-uuid' }, { ...billing, teamId: undefined }, { ...billing, teamId: `${teamId}/../../account` },
    { ...shift, shiftId: undefined }, { ...shift, shiftId: 'x' }, { ...shift, shiftId: `${shiftId}/delete` },
    { ...swap, swapId: undefined }, { ...swap, swapId: '../../team/revoke' },
    { ...shift, moment: 'swap_approved' }, { ...swap, moment: 'shift_created' }, { ...billing, moment: 'shift_created' },
  ];
  for (const raw of bad) assert.equal(parsePushData(raw), null, JSON.stringify(raw));
});

test('a path or any other extra field in the data is ignored: the screen is chosen by the app, never by the notification', () => {
  const t = parsePushData({ ...shift, path: '/account/sessions', url: 'https://evil.example', screen: '/billing' })!;
  assert.deepEqual(t, { type: 'shift_changes', moment: 'shift_updated', teamId, shiftId });
  assert.deepEqual(routeFor(t), { pathname: '/shift/[shiftId]', params: { shiftId } });
});

test("ids are normalised to lower case so they match the app's own ids", () => {
  const t = parsePushData({ ...shift, teamId: teamId.toUpperCase(), shiftId: shiftId.toUpperCase() })!;
  assert.equal(t.teamId, teamId);
  assert.deepEqual(routeFor(t), { pathname: '/shift/[shiftId]', params: { shiftId } });
});
