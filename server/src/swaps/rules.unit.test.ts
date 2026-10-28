import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSwapsConfig } from './config.js';
import { approverMayDecide } from './rules.js';
import { idempotencyKey } from './schemas.js';

const base = { requesterId: 'r', counterpartyId: 'c' } as const;

test('an Owner or Manager who is not in the swap may decide it; Staff never may', () => {
  assert.equal(approverMayDecide({ ...base, callerId: 'm', callerRole: 'manager', approverIds: ['m', 'o'] }), true);
  assert.equal(approverMayDecide({ ...base, callerId: 'o', callerRole: 'owner', approverIds: ['m', 'o'] }), true);
  assert.equal(approverMayDecide({ ...base, callerId: 's', callerRole: 'staff', approverIds: ['m', 'o'] }), false);
});

test('a Manager who is part of the swap may not decide it, even as the only Manager (the Owner can)', () => {
  assert.equal(approverMayDecide({ requesterId: 'm', counterpartyId: 'c', callerId: 'm', callerRole: 'manager', approverIds: ['m', 'o'] }), false);
  assert.equal(approverMayDecide({ requesterId: 'r', counterpartyId: 'm', callerId: 'm', callerRole: 'manager', approverIds: ['m'] }), false);
});

test('an Owner who is part of the swap may decide it ONLY when nobody else could (no other Owner or Manager)', () => {
  assert.equal(approverMayDecide({ requesterId: 'o', counterpartyId: 'c', callerId: 'o', callerRole: 'owner', approverIds: ['o'] }), true, 'the sole approver');
  assert.equal(approverMayDecide({ requesterId: 'o', counterpartyId: 'c', callerId: 'o', callerRole: 'owner', approverIds: ['o', 'm'] }), false, 'a Manager can decide it');
  assert.equal(approverMayDecide({ requesterId: 'r', counterpartyId: 'o', callerId: 'o', callerRole: 'owner', approverIds: ['o'] }), true, 'as the counterparty too');
});

test('the idempotency key header: a canonical lowercase UUID, nothing else', () => {
  assert.equal(idempotencyKey('3f2b8c1e-5a4d-4e7a-9c0b-1d2e3f4a5b6c'), '3f2b8c1e-5a4d-4e7a-9c0b-1d2e3f4a5b6c');
  for (const bad of [undefined, '', 'abc', '3F2B8C1E-5A4D-4E7A-9C0B-1D2E3F4A5B6C', ['3f2b8c1e-5a4d-4e7a-9c0b-1d2e3f4a5b6c'], ' 3f2b8c1e-5a4d-4e7a-9c0b-1d2e3f4a5b6c']) {
    assert.equal(idempotencyKey(bad as never), null, String(bad));
  }
});

test('the settings: 3 pending by default, an override, and a bad value stops the server', () => {
  assert.deepEqual(loadSwapsConfig({}), { maxPending: 3, listLimit: 50 });
  assert.equal(loadSwapsConfig({ SWAPS_MAX_PENDING: '5' }).maxPending, 5);
  for (const v of ['0', 'x', '1.5', '-1']) assert.throws(() => loadSwapsConfig({ SWAPS_MAX_PENDING: v }), v);
});
