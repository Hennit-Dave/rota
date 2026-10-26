import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, NetworkError, OfflineError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createInviteApi } from './inviteApi';

const token = '3278f64b-0284-4626-bd0c-1ed21ca65413.Zm9vYmFy';
const teamId = '11111111-1111-4111-8111-111111111111';
const pending = {
  status: 'pending',
  team: { name: 'The Olive Room' },
  role: 'staff',
  inviter: { name: 'Dave Hennit', role: 'owner' },
  email: 'amara@example.com',
  account: 'none',
};

test('preview signed out: POST /invitations/preview with the token in the body and no Authorization header', async () => {
  const h = makeHarness({ handler: () => json(200, pending) });
  const preview = await createInviteApi(h.client).preview(token, { signedIn: false });
  assert.equal(preview.status, 'pending');
  assert.equal(h.calls[0]?.path, '/invitations/preview');
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.authorization, null);
  assert.deepEqual(h.calls[0]?.body, { token }, 'only the token is sent');
});

test('preview signed in: the access token goes too, so the server can compare the account', async () => {
  const h = makeHarness({ handler: () => json(200, { ...pending, account: 'matches' }) });
  const preview = await createInviteApi(h.client).preview(token, { signedIn: true });
  assert.equal(preview.status === 'pending' && preview.account, 'matches');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('preview of a spent link by the account that used it: already_member, with the team to go to', async () => {
  const h = makeHarness({ handler: () => json(200, { status: 'already_member', team: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos' }, role: 'staff' }) });
  const preview = await createInviteApi(h.client).preview(token, { signedIn: true });
  assert.deepEqual(preview, { status: 'already_member', team: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'staff' } });
});

test('accept: POST /invitations/accept with the access token and the token only; the answer is the team', async () => {
  const h = makeHarness({ handler: () => json(200, { team: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos' }, role: 'staff' }) });
  const team = await createInviteApi(h.client).accept(token);
  assert.deepEqual(team, { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'staff' });
  assert.equal(h.calls[0]?.path, '/invitations/accept');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
  assert.deepEqual(h.calls[0]?.body, { token }, 'no user, role or team is ever sent');
});

test('server answers reach the caller unchanged: 404 invite_unavailable, 403 invite_wrong_account, and offline sends nothing', async () => {
  const gone = makeHarness({ handler: () => json(404, { error: { code: 'invite_unavailable', message: 'x', requestId: 'req-1' } }) });
  await assert.rejects(createInviteApi(gone.client).preview(token, { signedIn: false }), (e) => e instanceof ApiError && e.status === 404 && e.code === 'invite_unavailable');
  const wrong = makeHarness({ handler: () => json(403, { error: { code: 'invite_wrong_account', message: 'x', requestId: 'req-2' } }) });
  await assert.rejects(createInviteApi(wrong.client).accept(token), (e) => e instanceof ApiError && e.status === 403 && e.code === 'invite_wrong_account');
  const offline = makeHarness({ handler: () => json(200, pending), online: () => false });
  await assert.rejects(createInviteApi(offline.client).accept(token), OfflineError);
  assert.equal(offline.calls.length, 0);
});

test('preview offline: it fails at once with OfflineError and sends nothing (so the screen shows the offline state, never a wait)', async () => {
  const h = makeHarness({ handler: () => json(200, pending), online: () => false });
  await assert.rejects(createInviteApi(h.client).preview(token, { signedIn: false }), OfflineError);
  await assert.rejects(createInviteApi(h.client).preview(token, { signedIn: true }), OfflineError);
  assert.equal(h.calls.length, 0);
});

test('preview that the server never answers: it ends with a timed-out NetworkError, it cannot hang for ever', async () => {
  const hang = (_call: unknown, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const h = makeHarness({ handler: hang, timeoutMs: 20 });
  await assert.rejects(createInviteApi(h.client).preview(token, { signedIn: false }), (e: unknown) => e instanceof NetworkError && e.timedOut);
  await assert.rejects(createInviteApi(h.client).accept(token), (e: unknown) => e instanceof NetworkError && e.timedOut);
});

const sentInvitation = { id: 'i1', email: 'sofia@example.com', role: 'staff', expiresAt: '2026-10-30T18:33:23.352Z', emailStatus: 'queued', canResend: true, canRevoke: true };

test('createInvitation: POST /teams/:teamId/invitations sends only the address (trimmed) and the role, with the access token', async () => {
  const h = makeHarness({ handler: () => json(201, { invitation: sentInvitation }) });
  const result = await createInviteApi(h.client).createInvitation(teamId, { email: '  sofia@example.com ', role: 'staff' });
  assert.equal(result.emailStatus, 'queued');
  assert.equal(h.calls[0]?.path, `/teams/${teamId}/invitations`);
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
  assert.deepEqual(h.calls[0]?.body, { email: 'sofia@example.com', role: 'staff' }, 'no team, user, or permission is ever sent');
});

test('resendInvitation: POST …/invitations/:id/resend with no body', async () => {
  const h = makeHarness({ handler: () => json(200, { invitation: sentInvitation }) });
  await createInviteApi(h.client).resendInvitation(teamId, 'i1');
  assert.equal(h.calls[0]?.path, `/teams/${teamId}/invitations/i1/resend`);
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.body, undefined);
});

test('create: the server\'s 409s and 429 reach the screen unchanged; offline sends nothing', async () => {
  const conflict = makeHarness({ handler: () => json(409, { error: { code: 'already_member', message: 'x', requestId: 'req-1' } }) });
  await assert.rejects(createInviteApi(conflict.client).createInvitation(teamId, { email: 'a@b.co', role: 'staff' }), (e) => e instanceof ApiError && e.status === 409 && e.code === 'already_member');
  const offline = makeHarness({ handler: () => json(201, { invitation: sentInvitation }), online: () => false });
  await assert.rejects(createInviteApi(offline.client).createInvitation(teamId, { email: 'a@b.co', role: 'staff' }), OfflineError);
  assert.equal(offline.calls.length, 0);
});

test('listInvitations: GET /teams/:teamId/invitations with the access token', async () => {
  const h = makeHarness({ handler: () => json(200, { invitations: [sentInvitation] }) });
  const list = await createInviteApi(h.client).listInvitations(teamId);
  assert.equal(list.length, 1);
  assert.equal(h.calls[0]?.path, `/teams/${teamId}/invitations`);
  assert.equal(h.calls[0]?.method, 'GET');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('revokeInvitation: DELETE …/invitations/:id with no body; the 204 is success; a 404 reaches the screen unchanged', async () => {
  const ok = makeHarness({ handler: () => new Response(null, { status: 204 }) });
  await createInviteApi(ok.client).revokeInvitation(teamId, 'i1');
  assert.equal(ok.calls[0]?.path, `/teams/${teamId}/invitations/i1`);
  assert.equal(ok.calls[0]?.method, 'DELETE');
  assert.equal(ok.calls[0]?.authorization, 'Bearer old');
  assert.equal(ok.calls[0]?.body, undefined);
  const gone = makeHarness({ handler: () => json(404, { error: { code: 'not_found', message: 'x', requestId: 'req-3' } }) });
  await assert.rejects(createInviteApi(gone.client).revokeInvitation(teamId, 'i1'), (e) => e instanceof ApiError && e.status === 404 && e.code === 'not_found');
  const offline = makeHarness({ handler: () => new Response(null, { status: 204 }), online: () => false });
  await assert.rejects(createInviteApi(offline.client).revokeInvitation(teamId, 'i1'), OfflineError);
  assert.equal(offline.calls.length, 0);
});
