import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { channelFor, MOMENT_TYPE, PUSH_CHANNELS, PUSH_MOMENTS, PUSH_TYPES, pushDataFor, pushEventPayload } from './message.js';
import { PUSH_TEXT } from './events.js';
import { shiftEventRecipients, swapDecidedRecipients, swapRequestedRecipients } from './recipients.js';

const id = () => randomUUID();

test('a shift is told to the person it is assigned to, never to the person who made the change', () => {
  const [actor, staff] = [id(), id()];
  assert.deepEqual(shiftEventRecipients({ actorUserId: actor, assignedUserId: staff }), [staff]);
  assert.deepEqual(shiftEventRecipients({ actorUserId: actor, assignedUserId: actor }), [], 'a manager who assigns themselves is not told about it');
});

test('an open shift tells nobody', () => {
  assert.deepEqual(shiftEventRecipients({ actorUserId: id(), assignedUserId: null }), []);
});

test('an update that moves a shift from one person to another tells both, once each', () => {
  const [actor, from, to] = [id(), id(), id()];
  assert.deepEqual(shiftEventRecipients({ actorUserId: actor, assignedUserId: to, previousAssignedUserId: from }), [to, from]);
  assert.deepEqual(shiftEventRecipients({ actorUserId: actor, assignedUserId: to, previousAssignedUserId: to }), [to], 'the same person twice is one push');
  assert.deepEqual(shiftEventRecipients({ actorUserId: actor, assignedUserId: null, previousAssignedUserId: from }), [from], 'a shift made open tells the person who lost it');
});

test('a swap request tells the approvers it needs them, and the other party that it was asked, but never the requester or a party as an approver', () => {
  const [requester, counterparty, owner, manager] = [id(), id(), id(), id()];
  const r = swapRequestedRecipients({ actorUserId: requester, counterpartyUserId: counterparty, approverIds: [owner, manager, requester, counterparty] });
  assert.deepEqual(r.approvers, [owner, manager], 'a party to the swap may not decide it, so it is not told "needs your approval"');
  assert.deepEqual(r.counterparty, [counterparty]);
});

test('a swap decision tells both people in it and never the person who decided', () => {
  const [manager, requester, counterparty] = [id(), id(), id()];
  assert.deepEqual(swapDecidedRecipients({ actorUserId: manager, requesterUserId: requester, counterpartyUserId: counterparty }), [requester, counterparty]);
  assert.deepEqual(swapDecidedRecipients({ actorUserId: requester, requesterUserId: requester, counterpartyUserId: counterparty }), [counterparty]);
});

test('every moment maps to one of the three types, and every type has its own channel', () => {
  for (const moment of PUSH_MOMENTS) assert.ok((PUSH_TYPES as readonly string[]).includes(MOMENT_TYPE[moment]), moment);
  assert.deepEqual(Object.keys(PUSH_CHANNELS).sort(), [...PUSH_TYPES].sort());
  assert.equal(new Set(Object.values(PUSH_CHANNELS)).size, 3, 'three different channels');
  assert.equal(channelFor('billing'), 'billing');
  assert.equal(channelFor(MOMENT_TYPE.shift_updated), 'shift_changes');
  assert.equal(channelFor(MOMENT_TYPE.swap_approved), 'swap_updates');
  assert.ok(!Object.values(PUSH_CHANNELS).includes('default' as never), 'part 2 does not send on the part 1 channel');
});

test('what the phone receives for a shift or swap: the ids the app maps to a screen, and nothing else', () => {
  const [teamId, shiftId, swapId] = [id(), id(), id()];
  assert.deepEqual(pushDataFor({ moment: 'shift_updated', teamId, shiftId }), { v: 1, type: 'shift_changes', moment: 'shift_updated', teamId, shiftId });
  assert.deepEqual(pushDataFor({ moment: 'swap_requested', teamId, swapId }), { v: 1, type: 'swap_updates', moment: 'swap_requested', teamId, swapId });
  assert.deepEqual(pushDataFor({ moment: 'renewal_failed', teamId }), { v: 1, type: 'billing', moment: 'renewal_failed', teamId });
});

test('the lock-screen words are short and generic: no title, time, name or amount; every text fits the event payload', () => {
  for (const [key, text] of Object.entries(PUSH_TEXT)) {
    assert.ok(text.title.length <= 60 && text.body.length <= 80, key);
    assert.doesNotMatch(`${text.title} ${text.body}`, /\d|\$|@/, `${key} carries no digit, amount or address`);
    const moment = key.startsWith('swap_requested') ? 'swap_requested' : key;
    assert.equal(pushEventPayload.safeParse({ moment, teamId: id(), recipients: [id()], ...text, ...(moment.startsWith('swap') ? { swapId: id() } : { shiftId: id() }) }).success, true, key);
  }
});

test("the channels the app creates are exactly the channels the server names (plus the part 1 `default`): a mismatch would drop pushes silently", async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../../app/src/notifications/registration.ts', import.meta.url), 'utf8');
  const inApp = [...source.matchAll(/\{ id: '([a-z_]+)', name: '/g)].map((m) => m[1]!).sort();
  assert.deepEqual(inApp, [...Object.values(PUSH_CHANNELS), 'default'].sort());
});
