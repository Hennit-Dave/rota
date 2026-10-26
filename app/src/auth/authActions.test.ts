import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, StaleAccountError, TokenSaveError } from '../api/errors';
import { deferred, json, makeHarness, type Handler } from '../testkit';
import { createAuthActions } from './authActions';
import type { AuthUser } from './authResponses';

const user = { id: 'u1', email: 'amara@example.com', name: 'Amara Okafor', emailVerified: false };
const answer = { user, session: { accessToken: 'A1', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', refreshToken: 'R1' } };

function setup(handler: Handler) {
  const h = makeHarness({ handler, tokens: null });
  const signedIn: AuthUser[] = [];
  const actions = createAuthActions({
    client: h.client,
    tokens: h.tokens,
    epoch: h.epoch,
    onSignedIn: (u) => signedIn.push(u),
  });
  return { h, signedIn, actions };
}

test('login: no token is attached, the tokens are saved, then the user is signed in', async () => {
  const { h, signedIn, actions } = setup(() => json(200, answer));
  const result = await actions.login('amara@example.com', 'correct horse battery staple');
  assert.deepEqual(result, user);
  assert.equal(h.calls[0]?.path, '/auth/login');
  assert.equal(h.calls[0]?.authorization, null, 'a public route sends no Authorization header');
  assert.deepEqual(h.calls[0]?.body, { email: 'amara@example.com', password: 'correct horse battery staple' });
  assert.deepEqual(h.tokens.current(), { accessToken: 'A1', refreshToken: 'R1' });
  assert.deepEqual(signedIn, [user]);
});

test('register sends name, email and password to /auth/register', async () => {
  const { h, actions } = setup(() => json(201, answer));
  await actions.register('Amara Okafor', 'amara@example.com', 'a very long passphrase');
  assert.equal(h.calls[0]?.path, '/auth/register');
  assert.deepEqual(h.calls[0]?.body, { name: 'Amara Okafor', email: 'amara@example.com', password: 'a very long passphrase' });
});

test('a 401 invalid_credentials is NOT a refresh and NOT a sign-out: it reaches the screen as an error, nothing saved', async () => {
  const { h, signedIn, actions } = setup(() => json(401, { error: { code: 'invalid_credentials', message: 'x', requestId: 'req-1' } }));
  await assert.rejects(actions.login('a@b.c', 'pw'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_credentials');
  assert.equal(h.refreshCalls(), 0);
  assert.equal(h.invalidated.length, 0);
  assert.equal(h.tokens.current(), null);
  assert.equal(signedIn.length, 0);
});

test('a 429 carries the server\'s Retry-After to the screen', async () => {
  const { actions } = setup(() => json(429, { error: { code: 'rate_limited', message: 'x', requestId: 'r' } }, { 'Retry-After': '720' }));
  await assert.rejects(actions.login('a@b.c', 'pw'), (error: unknown) => error instanceof ApiError && error.retryAfterSeconds === 720);
});

test('the Retry-After falls back to the body when the header is missing', async () => {
  const { actions } = setup(() => json(429, { error: { code: 'rate_limited', message: 'x', requestId: 'r', retryAfterSeconds: 90 } }));
  await assert.rejects(actions.login('a@b.c', 'pw'), (error: unknown) => error instanceof ApiError && error.retryAfterSeconds === 90);
});

test('an answer that cannot be read saves nothing and signs nobody in', async () => {
  const { h, signedIn, actions } = setup(() => json(200, { user, session: { accessToken: 1 } }));
  await assert.rejects(actions.login('a@b.c', 'pw'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  assert.equal(h.tokens.current(), null);
  assert.equal(signedIn.length, 0);
});

test('app-state test 9: signing out while the request is in flight discards the answer; nothing is stored or signed in', async () => {
  const gate = deferred();
  const { h, signedIn, actions } = setup(async () => {
    await gate.promise;
    return json(200, answer);
  });
  const pending = actions.login('a@b.c', 'pw');
  h.epoch.bump(); // a sign-out (or an account switch) happens while the request is out
  gate.resolve();
  await assert.rejects(pending, StaleAccountError);
  assert.equal(h.tokens.writes.length, 0, 'the old request never wrote a token');
  assert.equal(h.tokens.current(), null);
  assert.equal(signedIn.length, 0);
});

test('a sign-out that races the token write is undone: the tokens it raced with are cleared again', async () => {
  const { h, signedIn, actions } = setup(() => json(200, answer));
  const write = h.tokens.write;
  h.tokens.write = async (tokens) => {
    await write(tokens);
    h.epoch.bump(); // the sign-out lands during the write
  };
  await assert.rejects(actions.login('a@b.c', 'pw'), StaleAccountError);
  assert.equal(h.tokens.current(), null);
  assert.equal(signedIn.length, 0);
});

test('if secure-store refuses the write the user is not signed in, and the error is a token-save error', async () => {
  const { h, signedIn, actions } = setup(() => json(200, answer));
  h.tokens.failWrites = true;
  await assert.rejects(actions.login('a@b.c', 'pw'), TokenSaveError);
  assert.equal(signedIn.length, 0);
});

test('redeemMagicLink: the token goes in the body of a public POST, and the session is stored and signed in like a login', async () => {
  const { h, signedIn, actions } = setup(() => json(200, answer));
  const result = await actions.redeemMagicLink('M'.repeat(43));
  assert.deepEqual(result, user);
  assert.equal(h.calls[0]?.path, '/auth/magic-link/redeem', 'the token is in the body, never the path');
  assert.equal(h.calls[0]?.authorization, null);
  assert.deepEqual(h.calls[0]?.body, { token: 'M'.repeat(43) });
  assert.deepEqual(h.tokens.current(), { accessToken: 'A1', refreshToken: 'R1' });
  assert.deepEqual(signedIn, [user]);
});

test('redeemMagicLink: an unavailable link stores nothing and signs nobody in, and it is not a refresh', async () => {
  const { h, signedIn, actions } = setup(() => json(404, { error: { code: 'link_unavailable', message: 'x', requestId: 'req-1' } }));
  await assert.rejects(actions.redeemMagicLink('M'.repeat(43)), (e: unknown) => e instanceof ApiError && e.code === 'link_unavailable');
  assert.equal(h.tokens.current(), null);
  assert.equal(h.refreshCalls(), 0);
  assert.equal(signedIn.length, 0);
});

test('redeemMagicLink: signing out while the request is in flight discards the session it returns', async () => {
  const gate = deferred();
  const { h, signedIn, actions } = setup(async () => {
    await gate.promise;
    return json(200, answer);
  });
  const pending = actions.redeemMagicLink('M'.repeat(43));
  h.epoch.bump();
  gate.resolve();
  await assert.rejects(pending, StaleAccountError);
  assert.equal(h.tokens.writes.length, 0);
  assert.equal(signedIn.length, 0);
});

test('redeemMagicLink with a session to replace: it is replaced AFTER the server accepts the link and BEFORE the new tokens are stored', async () => {
  const order: string[] = [];
  const { h, signedIn, actions } = setup(() => {
    order.push('server answered');
    return json(200, answer);
  });
  await actions.redeemMagicLink('M'.repeat(43), {
    replacingSession: async () => {
      order.push('old session replaced');
      assert.equal(h.tokens.writes.length, 0, 'the new tokens are not stored yet');
      h.epoch.bump(); // a real sign-out bumps the epoch; the new session must still be accepted
    },
  });
  assert.deepEqual(order, ['server answered', 'old session replaced']);
  assert.deepEqual(h.tokens.current(), { accessToken: 'A1', refreshToken: 'R1' });
  assert.deepEqual(signedIn, [user]);
});

test('redeemMagicLink with a session to replace: a link the server rejects leaves that session alone', async () => {
  let replaced = 0;
  const { h, signedIn, actions } = setup(() => json(404, { error: { code: 'link_unavailable', message: 'x', requestId: 'req-1' } }));
  await assert.rejects(
    actions.redeemMagicLink('M'.repeat(43), { replacingSession: async () => void replaced++ }),
    (e: unknown) => e instanceof ApiError && e.code === 'link_unavailable',
  );
  assert.equal(replaced, 0, 'the signed-in account was not logged out');
  assert.equal(h.tokens.writes.length, 0);
  assert.equal(signedIn.length, 0);
});
