import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bearer, startAuthTestApp, type TestApp } from './testkit.js';

let app: TestApp;
before(async () => {
  app = await startAuthTestApp();
});
after(() => app.stop());

const expect401 = (r: { status: number; body: any; headers: Headers }) => {
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'unauthenticated');
};
const refresh = (refreshToken: string) => app.post('/auth/refresh', { refreshToken });

test('logout: 204, and that session\'s access AND refresh tokens are dead on the very next request', async () => {
  const u = await app.seedUser();
  const s = await app.startSession(u.id);
  assert.equal((await app.get('/auth/me', bearer(s.accessToken))).status, 200);

  const res = await app.post('/auth/logout', undefined, bearer(s.accessToken));
  assert.equal(res.status, 204);
  assert.equal(res.text, '');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const family = await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: s.familyId } });
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, 'logout');
  expect401(await app.get('/auth/me', bearer(s.accessToken)));
  expect401(await refresh(s.refreshToken));
  // A refresh after logout is a refused session, not theft: the reason stays "logout".
  assert.equal((await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: s.familyId } })).revokedReason, 'logout');
});

test('logout needs a valid session: no token, a bad token, or a second logout are all 401', async () => {
  expect401(await app.post('/auth/logout'));
  expect401(await app.post('/auth/logout', undefined, bearer('not.a.token')));
  const u = await app.seedUser();
  const s = await app.startSession(u.id);
  assert.equal((await app.post('/auth/logout', undefined, bearer(s.accessToken))).status, 204);
  expect401(await app.post('/auth/logout', undefined, bearer(s.accessToken)));
});

test('logout kills ONLY this device: the same user\'s other session keeps working and can refresh', async () => {
  const u = await app.seedUser();
  const phone = await app.startSession(u.id);
  const tablet = await app.startSession(u.id);

  assert.equal((await app.post('/auth/logout', undefined, bearer(phone.accessToken))).status, 204);

  expect401(await app.get('/auth/me', bearer(phone.accessToken)));
  assert.equal((await app.get('/auth/me', bearer(tablet.accessToken))).status, 200);
  const rotated = await refresh(tablet.refreshToken);
  assert.equal(rotated.status, 200);
  assert.equal((await app.get('/auth/me', bearer(rotated.body.session.accessToken))).status, 200);
});

test('logout-all (#9): every family of the user is dead at once; another user is untouched', async () => {
  const u = await app.seedUser();
  const sessions = [await app.startSession(u.id), await app.startSession(u.id), await app.startSession(u.id)];
  // One family is already gone before logout-all; it must keep its original reason.
  assert.equal((await app.post('/auth/logout', undefined, bearer(sessions[2]!.accessToken))).status, 204);
  // The first session has rotated once, so the tokens from that rotation must die too.
  const rotated = await refresh(sessions[0]!.refreshToken);
  const other = await app.seedUser();
  const bystander = await app.startSession(other.id);

  const res = await app.post('/auth/logout-all', undefined, bearer(sessions[1]!.accessToken));
  assert.equal(res.status, 204);

  for (const s of sessions) {
    expect401(await app.get('/auth/me', bearer(s.accessToken)));
    expect401(await refresh(s.refreshToken));
  }
  expect401(await app.get('/auth/me', bearer(rotated.body.session.accessToken)));
  expect401(await refresh(rotated.body.session.refreshToken));

  const families = await app.db.refreshTokenFamily.findMany({ where: { userId: u.id } });
  assert.equal(families.length, 3);
  assert.ok(families.every((f) => f.revokedAt !== null));
  const reasonOf = (id: string) => families.find((f) => f.id === id)!.revokedReason;
  assert.equal(reasonOf(sessions[2]!.familyId), 'logout', 'an earlier revocation keeps its reason');
  assert.equal(reasonOf(sessions[0]!.familyId), 'logout_all');
  assert.equal(reasonOf(sessions[1]!.familyId), 'logout_all');

  assert.equal((await app.get('/auth/me', bearer(bystander.accessToken))).status, 200, 'another user is unaffected');
  assert.equal((await refresh(bystander.refreshToken)).status, 200);
  const logged = app.logLines().map((l) => JSON.parse(l)).find((l) => l.msg === 'session_revoked' && l.reason === 'logout_all' && l.userId === u.id);
  assert.equal(logged?.outcome, 'families_revoked_2');
});

test('validation: logout routes take no body and no query, checked before auth', async () => {
  const u = await app.seedUser();
  const s = await app.startSession(u.id);
  for (const path of ['/auth/logout', '/auth/logout-all']) {
    const withBody = await app.post(path, { sneaky: true }, bearer(s.accessToken));
    assert.equal(withBody.status, 400, path);
    assert.equal(withBody.body.error.code, 'validation_failed');
    const withQuery = await app.post(`${path}?x=1`, undefined, bearer(s.accessToken));
    assert.equal(withQuery.status, 400, path);
  }
  assert.equal((await app.get('/auth/me', bearer(s.accessToken))).status, 200, 'rejected requests revoked nothing');
});
