import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createRecoveryApi } from './recoveryApi';

const accepted = () => json(202, { ok: true });
const SECRET = 'S'.repeat(43);

test('a reset or magic-link request is a public POST with the address in the body: no token attached, nothing in the URL', async () => {
  const h = makeHarness({ handler: accepted, tokens: { accessToken: 'live', refreshToken: 'r' } });
  const api = createRecoveryApi(h.client);
  await api.requestMagicLink(' Sofia@Example.com ');
  await api.requestPasswordReset('sofia@example.com');
  assert.deepEqual(
    h.calls.map((c) => [c.method, c.path, c.authorization, c.body]),
    [
      ['POST', '/auth/magic-link/request', null, { email: 'Sofia@Example.com' }],
      ['POST', '/auth/password-reset/request', null, { email: 'sofia@example.com' }],
    ],
    'public routes send no Authorization header even while signed in',
  );
});

test('submitting a reset puts the token and the password in the body only, and a 204 is success', async () => {
  const h = makeHarness({ handler: () => new Response(null, { status: 204 }), tokens: null });
  await createRecoveryApi(h.client).submitPasswordReset(SECRET, 'a-brand-new-passphrase-1');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.path, '/auth/password-reset/submit', 'the secret is never in the path');
  assert.equal(h.calls[0]!.authorization, null);
  assert.deepEqual(h.calls[0]!.body, { token: SECRET, password: 'a-brand-new-passphrase-1' });
});

test('a link the server will not take is the server\'s one 404 link_unavailable, passed on for the screen to read', async () => {
  const h = makeHarness({ handler: () => json(404, { error: { code: 'link_unavailable', message: 'x', requestId: 'req-9' } }), tokens: null });
  await assert.rejects(
    createRecoveryApi(h.client).submitPasswordReset(SECRET, 'a-brand-new-passphrase-1'),
    (e: unknown) => e instanceof ApiError && e.code === 'link_unavailable' && e.status === 404,
  );
  assert.equal(h.refreshCalls(), 0, 'a public route never triggers a refresh');
  assert.equal(h.invalidated.length, 0, 'and never signs anyone out');
});

test('a 429 carries the server\'s wait to the screen', async () => {
  const h = makeHarness({ handler: () => json(429, { error: { code: 'rate_limited', message: 'x', requestId: 'r' } }, { 'Retry-After': '300' }), tokens: null });
  await assert.rejects(createRecoveryApi(h.client).requestPasswordReset('a@b.c'), (e: unknown) => e instanceof ApiError && e.retryAfterSeconds === 300);
});
