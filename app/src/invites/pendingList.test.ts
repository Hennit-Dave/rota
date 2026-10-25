import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pendingListStatus } from './pendingList';

const detail = (over: Partial<{ loaded: boolean; failed: boolean; canManageInvitations: boolean }> = {}) => ({ loaded: true, failed: false, canManageInvitations: true, ...over });
const list = (over: Partial<{ loaded: boolean; failed: boolean; count: number }> = {}) => ({ loaded: false, failed: false, count: 0, ...over });

test('a list that arrived: empty (Figma 292:675) or ready (292:526)', () => {
  assert.equal(pendingListStatus({ detail: detail(), list: list({ loaded: true, count: 0 }) }), 'empty');
  assert.equal(pendingListStatus({ detail: detail(), list: list({ loaded: true, count: 2 }) }), 'ready');
});

test('loading while either answer is on its way (292:610)', () => {
  assert.equal(pendingListStatus({ detail: detail({ loaded: false, canManageInvitations: false }), list: list() }), 'loading');
  assert.equal(pendingListStatus({ detail: detail(), list: list() }), 'loading');
});

test('it never waits for ever: a failed permission answer or a failed list is the error state with Try again (292:725)', () => {
  assert.equal(pendingListStatus({ detail: detail({ loaded: false, failed: true }), list: list() }), 'failed');
  assert.equal(pendingListStatus({ detail: detail(), list: list({ failed: true }) }), 'failed');
});

test('a person the server does not allow to list invitations (Staff) gets "not allowed", not a spinner', () => {
  assert.equal(pendingListStatus({ detail: detail({ canManageInvitations: false }), list: list() }), 'not_allowed');
});

test('a list already on screen stays on screen when a later refresh fails', () => {
  assert.equal(pendingListStatus({ detail: detail({ failed: true }), list: list({ loaded: true, count: 3, failed: true }) }), 'ready');
});
