import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { SignJWT } from 'jose';
import { identityDb } from '../db/identity.js';
import { startAuthTestApp, type TestApp } from './testkit.js';

let app: TestApp;
before(async () => {
  app = await startAuthTestApp();
});
after(() => app.stop());

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function login() {
  const u = await app.seedUser();
  const res = await app.post('/auth/login', { email: u.email, password: u.password });
  assert.equal(res.status, 200);
  const familyId = (await app.tokens.verify(res.body.session.accessToken)).familyId;
  return { u, accessToken: res.body.session.accessToken as string, familyId };
}

const expect401 = (r: { status: number; body: any; headers: Headers }) => {
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'unauthenticated');
  assert.equal(r.headers.get('www-authenticate'), 'Bearer');
};

test('/auth/me needs a token: missing, malformed and forged tokens are all the same 401', async () => {
  expect401(await app.get('/auth/me'));
  expect401(await app.get('/auth/me', { authorization: 'Bearer nonsense' }));
  expect401(await app.get('/auth/me', { authorization: 'Basic dXNlcjpwYXNz' }));
  const { accessToken } = await login();
  const [h, p, s] = accessToken.split('.') as [string, string, string];
  expect401(await app.get('/auth/me', bearer(`${h}.${p}.${s.slice(0, -2)}AA`)));
});

test('a valid access token with a live session is accepted', async () => {
  const { u, accessToken } = await login();
  const res = await app.get('/auth/me', bearer(accessToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, u.id);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('revoking the session stops the SAME access token on its very next request', async () => {
  const { accessToken, familyId } = await login();
  assert.equal((await app.get('/auth/me', bearer(accessToken))).status, 200);
  await app.db.refreshTokenFamily.update({ where: { id: familyId }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
  expect401(await app.get('/auth/me', bearer(accessToken)));
});

test('a family past its absolute expiry, or deleted, stops the token', async () => {
  const a = await login();
  await app.db.refreshTokenFamily.update({ where: { id: a.familyId }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
  expect401(await app.get('/auth/me', bearer(a.accessToken)));

  const b = await login();
  await app.db.refreshTokenFamily.delete({ where: { id: b.familyId } });
  expect401(await app.get('/auth/me', bearer(b.accessToken)));
});

test('a token whose family belongs to a DIFFERENT user is refused', async () => {
  const a = await login();
  const b = await login();
  const mismatched = await app.tokens.sign({ userId: a.u.id, familyId: b.familyId });
  expect401(await app.get('/auth/me', bearer(mismatched.token)));
});

test('an expired access token is refused (no skew allowance); a token issued later works', async () => {
  // Its own app: advancing the clock must not leak into the other tests.
  const timed = await startAuthTestApp();
  try {
    const u = await timed.seedUser();
    const first = await timed.post('/auth/login', { email: u.email, password: u.password });
    const old = first.body.session.accessToken as string;
    assert.equal((await timed.get('/auth/me', bearer(old))).status, 200);

    // A one-minute margin, because real time also passes between calls (database round trips take seconds).
    // The exact-millisecond boundary is pinned by tokens.unit.test.ts with a fixed clock.
    timed.advanceClock(14 * 60_000);
    assert.equal((await timed.get('/auth/me', bearer(old))).status, 200, 'still valid at 14 minutes');
    timed.advanceClock(2 * 60_000);
    expect401(await timed.get('/auth/me', bearer(old)));

    const fresh = await timed.post('/auth/login', { email: u.email, password: u.password });
    assert.equal(fresh.status, 200);
    assert.equal((await timed.get('/auth/me', bearer(fresh.body.session.accessToken))).status, 200);
  } finally {
    await timed.stop();
  }
});

test('alg "none", HS512 and a wrong-secret token are refused over HTTP', async () => {
  const { u, familyId } = await login();
  const body = Buffer.from(JSON.stringify({ sub: u.id, sid: familyId, iss: app.config.issuer, aud: app.config.audience, iat: 1, exp: 4_000_000_000 })).toString('base64url');
  // Control: the same claims, correctly signed, ARE accepted. So the three refusals below are about the algorithm / key alone.
  const control = await new SignJWT({ sid: familyId }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer(app.config.issuer).setAudience(app.config.audience)
    .setIssuedAt(app.now()).setExpirationTime(new Date(app.now().getTime() + 5 * 60_000)).sign(new Uint8Array(32).fill(3));
  assert.equal((await app.get('/auth/me', bearer(control))).status, 200);
  expect401(await app.get('/auth/me', bearer(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`)));

  const sign = (alg: string, key: Uint8Array) =>
    new SignJWT({ sid: familyId }).setProtectedHeader({ alg }).setSubject(u.id).setIssuer(app.config.issuer).setAudience(app.config.audience)
      .setIssuedAt(app.now()).setExpirationTime(new Date(app.now().getTime() + 5 * 60_000)).sign(key);
  expect401(await app.get('/auth/me', bearer(await sign('HS512', new Uint8Array(32).fill(3)))));
  expect401(await app.get('/auth/me', bearer(await sign('HS256', new Uint8Array(32).fill(4)))));
});

test('roles come from the server, never the token: a validly signed token with a role claim changes nothing', async () => {
  const { u, familyId } = await login();
  const token = await new SignJWT({ sid: familyId, role: 'owner', team: randomUUID() })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer(app.config.issuer).setAudience(app.config.audience)
    .setIssuedAt(app.now()).setExpirationTime(new Date(app.now().getTime() + 60_000)).sign(new Uint8Array(32).fill(3));
  const res = await app.get('/auth/me', bearer(token));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.user).sort(), ['email', 'emailVerified', 'id', 'name']);
});

test('the session check reads the PRIMARY: the identity client is not a replica (data.md)', async () => {
  const [row] = await identityDb(app.shards).$queryRaw<Array<{ in_recovery: boolean }>>`SELECT pg_is_in_recovery() AS in_recovery`;
  assert.equal(row!.in_recovery, false);
  assert.equal(app.db, identityDb(app.shards));
});

test('a /auth/me with a body or query string is rejected by validation before auth runs', async () => {
  const { accessToken } = await login();
  const res = await app.get('/auth/me?x=1', bearer(accessToken));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_failed');
});
