import assert from 'node:assert/strict';
import { test } from 'node:test';
import { json, makeHarness, session, type Handler } from '../testkit';
import type { AuthUser } from './authResponses';
import { createRestoreSession } from './restore';
import type { SignOutNotice } from './types';

const user = { id: 'u1', email: 'amara@example.com', name: 'Amara Okafor', emailVerified: true };
const meOk = () => json(200, { user });
const unauthenticated = () => json(401, { error: { code: 'unauthenticated', message: 'x', requestId: 'r' } });

function setup(options: { handler: Handler; tokens?: { accessToken: string; refreshToken: string } | null; online?: boolean }) {
  const h = makeHarness({ handler: options.handler, tokens: options.tokens, online: () => options.online !== false });
  const events: string[] = [];
  const signedInWith: Array<AuthUser | null> = [];
  const signOuts: SignOutNotice[] = [];
  const restore = createRestoreSession({
    tokens: h.tokens,
    client: h.client,
    signOutLocal: async (notice = 'none') => {
      signOuts.push(notice);
    },
    onSignedIn: (u) => {
      events.push('signedIn');
      signedInWith.push(u);
    },
    onSignedOut: () => events.push('signedOut'),
  });
  return { h, restore, events, signedInWith, signOuts };
}

test('no tokens on the device: signed out, and nothing is sent', async () => {
  const { h, restore, events } = setup({ handler: meOk, tokens: null });
  assert.equal(await restore(), 'signed_out');
  assert.deepEqual(events, ['signedOut']);
  assert.equal(h.calls.length, 0);
});

test('tokens that work: GET /auth/me proves the session, and the user it returns is handed over', async () => {
  const { h, restore, events, signedInWith } = setup({ handler: meOk });
  assert.equal(await restore(), 'signed_in');
  assert.equal(h.calls[0]?.path, '/auth/me');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
  assert.deepEqual(events, ['signedIn']);
  assert.deepEqual(signedInWith, [user]);
});

test('an expired access token is refreshed once, then /auth/me succeeds', async () => {
  let me = 0;
  const { h, restore } = setup({
    handler: (call) => {
      if (call.path === '/auth/refresh') return json(200, session('new', 'r2'));
      me += 1;
      return me === 1 ? unauthenticated() : meOk();
    },
  });
  assert.equal(await restore(), 'signed_in');
  assert.equal(h.refreshCalls(), 1);
  assert.equal(h.calls.filter((c) => c.path === '/auth/me').length, 2);
});

test('the server refuses the refresh: the session ended (the client has already signed out locally, so this does not do it twice)', async () => {
  const { h, restore, events, signOuts } = setup({ handler: unauthenticated });
  assert.equal(await restore(), 'session_ended');
  assert.deepEqual(h.invalidated, ['refresh_rejected']);
  assert.deepEqual(signOuts, []);
  assert.deepEqual(events, [], 'the signed-in side is never shown');
});

test('a 401 that survives a successful refresh also ends the session, with the session_ended notice', async () => {
  const { restore, signOuts, events } = setup({
    handler: (call) => (call.path === '/auth/refresh' ? json(200, session('new', 'r2')) : unauthenticated()),
  });
  assert.equal(await restore(), 'session_ended');
  assert.deepEqual(signOuts, ['session_ended']);
  assert.deepEqual(events, []);
});

test('app-state test 11: offline keeps the session, sends nothing, and the signed-in side shows its own offline state', async () => {
  const { h, restore, events, signedInWith, signOuts } = setup({ handler: meOk, online: false });
  assert.equal(await restore(), 'unverified');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(events, ['signedIn']);
  assert.deepEqual(signedInWith, [null], 'no user: it could not be asked');
  assert.deepEqual(signOuts, []);
  assert.deepEqual(h.tokens.current(), { accessToken: 'old', refreshToken: 'r1' }, 'tokens kept');
});

test('app-state test 11: a 503 keeps the session', async () => {
  const { restore, events, signOuts } = setup({ handler: () => json(503, { error: { code: 'service_unavailable', message: 'x', requestId: 'r' } }) });
  assert.equal(await restore(), 'unverified');
  assert.deepEqual(events, ['signedIn']);
  assert.deepEqual(signOuts, []);
});

test('app-state test 11: a refresh whose answer was lost is not replayed and the session is kept', async () => {
  let refreshes = 0;
  const { restore, signOuts, events } = setup({
    handler: (call) => {
      if (call.path === '/auth/refresh') {
        refreshes += 1;
        throw new TypeError('network dropped');
      }
      return unauthenticated();
    },
  });
  assert.equal(await restore(), 'unverified');
  assert.equal(refreshes, 1, 'sent once, never replayed');
  assert.deepEqual(signOuts, []);
  assert.deepEqual(events, ['signedIn']);
});

test('a 429 on refresh keeps the session', async () => {
  const { restore, signOuts } = setup({
    handler: (call) => (call.path === '/auth/refresh' ? json(429, { error: { code: 'rate_limited', message: 'x', requestId: 'r' } }, { 'Retry-After': '30' }) : unauthenticated()),
  });
  assert.equal(await restore(), 'unverified');
  assert.deepEqual(signOuts, []);
});

test('an /auth/me answer the app cannot read is not claimed as verified', async () => {
  const { restore, signedInWith } = setup({ handler: () => json(200, { unexpected: true }) });
  assert.equal(await restore(), 'unverified');
  assert.deepEqual(signedInWith, [null]);
});
