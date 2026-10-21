import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createBlocklist } from './blocklist.js';
import { startAuthTestApp, type TestApp } from './testkit.js';

let app: TestApp;
before(async () => {
  app = await startAuthTestApp({ blocklist: createBlocklist(['password1234567890']), rateLimits: { loginEmail: { max: 1, windowSeconds: 60 } } });
});
after(() => app.stop());

test('after register, login (ok, wrong, rate limited), /me and rejected requests, no log line holds a secret or an address', async () => {
  const password = 'Redaction-Test-Passphrase-1!';
  const wrong = 'Wrong-Passphrase-Attempt-9!';
  const email = app.newEmail();
  app.logLines().length = 0;

  const reg = await app.post('/auth/register', { name: 'Redaction Tester', email, password });
  assert.equal(reg.status, 201);
  const login = await app.post('/auth/login', { email, password });
  assert.equal(login.status, 200);
  assert.equal((await app.post('/auth/login', { email, password: wrong })).status, 429, 'second attempt for this email is over the limit');
  assert.equal((await app.post('/auth/login', { email: app.newEmail(), password: wrong })).status, 401);
  const me = await app.get('/auth/me', { authorization: `Bearer ${login.body.session.accessToken}` });
  assert.equal(me.status, 200);
  await app.get('/auth/me', { authorization: `Bearer ${login.body.session.accessToken.slice(0, -4)}abcd` });
  await app.post('/auth/register', { name: 'x', email: 'bad', password: 'Password1234567890' });
  await app.post('/auth/register', '{"name":', { 'content-type': 'application/json' });

  const dbUser = await app.db.user.findUniqueOrThrow({ where: { email }, include: { credential: true } });
  const secrets = [
    password, wrong, email, 'Redaction Tester', 'Password1234567890',
    reg.body.session.refreshToken, reg.body.session.accessToken,
    login.body.session.refreshToken, login.body.session.accessToken,
    login.body.session.accessToken.split('.')[1]!, // the token payload
    dbUser.credential!.passwordHash, '$argon2',
  ];
  const raw = app.logLines().join('\n');
  assert.ok(app.logLines().length >= 8, 'requests were logged');
  for (const s of secrets) assert.ok(!raw.includes(s), `a log line contains a secret: ${s.slice(0, 12)}…`);

  // Every request line still has the fields observability.md lists.
  const lines = app.logLines().map((l) => JSON.parse(l)).filter((l) => l.msg === 'request');
  for (const l of lines) for (const k of ['ts', 'requestId', 'method', 'route', 'status', 'durationMs']) assert.ok(k in l, `missing ${k}`);
  const unexpected = lines.filter((l) => !['/auth/register', '/auth/login', '/auth/me', '(unmatched)'].includes(l.route));
  assert.deepEqual(unexpected, [], 'every request line carries a route template');
  const meLine = lines.find((l) => l.route === '/auth/me' && l.status === 200)!;
  assert.equal(meLine.userId, dbUser.id);
  assert.equal(meLine.dbRoute, 'primary-required');
});
