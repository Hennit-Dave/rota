import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitePreviewOptions } from './invitePreviewOptions';

const base = { token: 'tok', session: 'signedIn' as const, focused: true };

test('the query runs even when the device is offline, so the screen can say so instead of waiting for ever', () => {
  assert.equal(invitePreviewOptions(base).networkMode, 'always');
});

test('it runs only with a token, a verified session and a focused screen', () => {
  assert.equal(invitePreviewOptions(base).enabled, true);
  assert.equal(invitePreviewOptions({ ...base, session: 'signedOut' }).enabled, true);
  assert.equal(invitePreviewOptions({ ...base, token: null }).enabled, false);
  assert.equal(invitePreviewOptions({ ...base, session: 'restoring' }).enabled, false);
  assert.equal(invitePreviewOptions({ ...base, focused: false }).enabled, false, 'a screen left underneath another does not keep checking');
});

test('nothing is kept after the screen leaves', () => {
  const o = invitePreviewOptions(base);
  assert.equal(o.gcTime, 0);
  assert.equal(o.staleTime, 0);
});
