import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startAuthTestApp, type TestApp } from './testkit.js';

let app: TestApp;
before(async () => {
  app = await startAuthTestApp();
});
after(() => app.stop());

test('login succeeds with the right password and starts a NEW session family each time', async () => {
  const u = await app.seedUser();
  const first = await app.post('/auth/login', { email: u.email, password: u.password });
  const second = await app.post('/auth/login', { email: u.email, password: u.password });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(first.body.user, { id: u.id, email: u.email, name: 'Seeded User', emailVerified: false });
  assert.equal(await app.db.refreshTokenFamily.count({ where: { userId: u.id } }), 2, 'one family per device login');
  assert.notEqual(first.body.session.refreshToken, second.body.session.refreshToken);
  const me = await app.get('/auth/me', { authorization: `Bearer ${first.body.session.accessToken}` });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, u.id);
});

test('unknown email and wrong password give the SAME response, and each runs exactly one Argon2 verification', async () => {
  const u = await app.seedUser();
  const strip = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });

  const before1 = app.verifyCount();
  const wrong = await app.post('/auth/login', { email: u.email, password: 'definitely-the-wrong-password' });
  const after1 = app.verifyCount();
  const unknown = await app.post('/auth/login', { email: app.newEmail(), password: 'definitely-the-wrong-password' });
  const after2 = app.verifyCount();

  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error.code, 'invalid_credentials');
  assert.deepEqual(strip(wrong), strip(unknown), 'indistinguishable bodies');
  assert.equal(after1 - before1, 1, 'wrong password: one verification');
  assert.equal(after2 - after1, 1, 'unknown email: one verification against the dummy hash, so timing matches');
  assert.equal(await app.db.refreshTokenFamily.count({ where: { userId: u.id } }), 0, 'a failed login creates no session');
});

test('an account with no credential row cannot log in and looks exactly like an unknown email', async () => {
  const email = app.newEmail();
  await app.db.user.create({ data: { email, name: 'No Password' } });
  const before = app.verifyCount();
  const res = await app.post('/auth/login', { email, password: 'whatever-password-value' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');
  assert.equal(app.verifyCount() - before, 1);
});

test('login applies no password policy: an old short password still works; a case/whitespace-different email matches', async () => {
  const u = await app.seedUser({ password: 'short' });
  const res = await app.post('/auth/login', { email: `  ${u.email.toUpperCase()}  `, password: 'short' });
  assert.equal(res.status, 200);
});

test('login validation: missing fields, unknown keys, over-long password are 400', async () => {
  assert.equal((await app.post('/auth/login', { email: 'a@b.co' })).status, 400);
  assert.equal((await app.post('/auth/login', { email: 'a@b.co', password: 'x', admin: true })).status, 400);
  const long = await app.post('/auth/login', { email: 'a@b.co', password: 'x'.repeat(129) });
  assert.equal(long.status, 400);
  assert.deepEqual(long.body.error.details, [{ path: 'password', code: 'too_long', max: 128 }]);
});

test('a failed login is logged with the reason and the user ID, but never the email or password', async () => {
  const u = await app.seedUser();
  app.logLines().length = 0;
  await app.post('/auth/login', { email: u.email, password: 'definitely-the-wrong-password' });
  await app.post('/auth/login', { email: app.newEmail(), password: 'definitely-the-wrong-password' });
  const events = app.logLines().map((l) => JSON.parse(l)).filter((l) => l.msg === 'login_failed');
  assert.deepEqual(events.map((e) => e.reason), ['bad_password', 'unknown_email']);
  assert.equal(events[0].userId, u.id);
  assert.ok(!('userId' in events[1]));
  const raw = app.logLines().join('\n');
  assert.ok(!raw.includes(u.email) && !raw.includes('definitely-the-wrong-password'));
});

test('per-email rate limit: the attempt over the limit is 429 and runs NO password verification', async () => {
  const limited = await startAuthTestApp({ rateLimits: { loginEmail: { max: 2, windowSeconds: 60 } } });
  try {
    const u = await limited.seedUser();
    const statuses = [];
    for (let i = 0; i < 2; i++) statuses.push((await limited.post('/auth/login', { email: u.email, password: 'wrong-password-value' })).status);
    assert.deepEqual(statuses, [401, 401]);
    const verifiesBefore = limited.verifyCount();

    const blocked = await limited.post('/auth/login', { email: u.email, password: u.password }); // the RIGHT password
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal(limited.verifyCount(), verifiesBefore, 'a blocked attempt never costs an Argon2 run');
    assert.equal(await limited.db.refreshTokenFamily.count({ where: { userId: u.id } }), 0, 'even the right password gets no session while blocked');

    // A different email is unaffected by this email's counter.
    const other = await limited.seedUser();
    assert.equal((await limited.post('/auth/login', { email: other.email, password: other.password })).status, 200);
  } finally {
    await limited.stop();
  }
});

test('per-IP rate limit applies across different emails', async () => {
  const limited = await startAuthTestApp({ rateLimits: { loginIp: { max: 3, windowSeconds: 60 } } });
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await limited.post('/auth/login', { email: limited.newEmail(), password: 'wrong-password-value' })).status);
    assert.deepEqual(codes, [401, 401, 401, 429]);
  } finally {
    await limited.stop();
  }
});

test('with Valkey down, login fails closed (503) before any password verification and creates no session; /auth/me still works', async () => {
  const down = await startAuthTestApp({ deadValkey: true });
  try {
    const u = await down.seedUser();
    const res = await down.post('/auth/login', { email: u.email, password: u.password });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(down.verifyCount(), 0);
    assert.equal(await down.db.refreshTokenFamily.count({ where: { userId: u.id } }), 0);

    // /auth/me is not on the rate-limited list: it needs only a token and the session row in Postgres, so it keeps
    // working while Valkey is down. (Both test apps share one signing secret, so the healthy app's token is valid here.)
    const healthy = await app.post('/auth/login', { email: u.email, password: u.password });
    assert.equal(healthy.status, 200);
    const me = await down.get('/auth/me', { authorization: `Bearer ${healthy.body.session.accessToken}` });
    assert.equal(me.status, 200);
  } finally {
    await down.stop();
  }
});
