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
