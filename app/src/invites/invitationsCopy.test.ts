import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directoryInvitationCaption, invitationCaption, invitationsCopy } from './invitationsCopy';

test('"Email not sent · Staff" is red; queued and sent both read "Pending · Manager" (Figma 294:3986)', () => {
  assert.deepEqual(invitationCaption({ emailStatus: 'failed', role: 'staff' }), { text: 'Email not sent · Staff', tone: 'danger' });
  assert.deepEqual(invitationCaption({ emailStatus: 'queued', role: 'manager' }), { text: 'Pending · Manager', tone: 'muted' });
  assert.deepEqual(invitationCaption({ emailStatus: 'sent', role: 'manager' }), { text: 'Pending · Manager', tone: 'muted' });
});

test('the directory block says "Invitation pending", or "Email not sent" in red when the server says so (Figma 32:1324)', () => {
  assert.deepEqual(directoryInvitationCaption({ emailStatus: 'queued' }), { text: 'Invitation pending', tone: 'muted' });
  assert.deepEqual(directoryInvitationCaption({ emailStatus: 'failed' }), { text: 'Email not sent', tone: 'danger' });
});

test('the revoke question names the address (Figma 292:988)', () => {
  assert.equal(invitationsCopy.revokeConfirm.title('sofia@example.com'), 'Revoke invitation for sofia@example.com?');
});
