import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createBlocklist } from './blocklist.js';
import { startAuthTestApp, type TestApp } from './testkit.js';

let app: TestApp;
before(async () => {
  app = await startAuthTestApp({ blocklist: createBlocklist(['password1234567890']) });
});
after(() => app.stop());

const DAY = 86_400_000;
const good = (email: string, extra: Record<string, unknown> = {}) => ({ name: 'Amara Okafor', email, password: 'a-long-enough-passphrase', ...extra });
const userCount = (email: string) => app.db.user.count({ where: { email: email.trim().toLowerCase() } });

test('register creates the user, credential, one session family and one refresh token, and returns a working session', async () => {
  const email = app.newEmail();
  const password = 'a-long-enough-passphrase';
  const res = await app.post('/auth/register', { name: '  Amara Okafor ', email: `  ${email.toUpperCase()} `, password });

  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/);
  const { user, session } = res.body;
  assert.deepEqual(user, { id: user.id, email, name: 'Amara Okafor', emailVerified: false });
  assert.match(session.refreshToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(new Date(session.accessTokenExpiresAt).getTime() - (Date.now() + 15 * 60_000)) < 60_000);

  // What is stored, straight from the database.
  const cred = await app.db.credential.findUniqueOrThrow({ where: { userId: user.id } });
  assert.match(cred.passwordHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(!cred.passwordHash.includes(password));
  const families = await app.db.refreshTokenFamily.findMany({ where: { userId: user.id }, include: { tokens: true } });
  assert.equal(families.length, 1);
  const [family] = families;
  assert.equal(family!.revokedAt, null);
  assert.ok(Math.abs(family!.absoluteExpiresAt.getTime() - (Date.now() + 90 * DAY)) < 5 * 60_000, 'absolute lifetime ~90 days');
  assert.equal(family!.tokens.length, 1);
  const stored = family!.tokens[0]!;
  assert.deepEqual(Buffer.from(stored.tokenHash), createHash('sha256').update(session.refreshToken).digest());
  assert.notDeepEqual(Buffer.from(stored.tokenHash), Buffer.from(session.refreshToken));
  assert.equal(stored.usedAt, null);
  assert.ok(Math.abs(stored.idleExpiresAt.getTime() - (Date.now() + 30 * DAY)) < 5 * 60_000, 'idle expiry ~30 days');

  // The access token names that family and works immediately.
  assert.deepEqual(await app.tokens.verify(session.accessToken), { userId: user.id, familyId: family!.id });
  const me = await app.get('/auth/me', { authorization: `Bearer ${session.accessToken}` });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user, user);

  // The response carries no hash and no password.
  assert.ok(!res.text.includes('argon2') && !res.text.includes(password));
});

test('a second registration of the same address is 409, whatever its letter case; still one user', async () => {
  const email = app.newEmail();
  assert.equal((await app.post('/auth/register', good(email))).status, 201);
  const again = await app.post('/auth/register', good(email.toUpperCase(), { name: 'Someone Else' }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'email_in_use');
  assert.equal(await userCount(email), 1);
});

test('two simultaneous registrations of one address: exactly one 201 and one 409, with no orphan rows', async () => {
  const email = app.newEmail();
  const results = await Promise.all([app.post('/auth/register', good(email)), app.post('/auth/register', good(email))]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await userCount(email), 1);
  const user = await app.db.user.findUniqueOrThrow({ where: { email } });
  assert.equal(await app.db.credential.count({ where: { userId: user.id } }), 1);
  assert.equal(await app.db.refreshTokenFamily.count({ where: { userId: user.id } }), 1, 'the loser\'s transaction rolled back completely');
});

test('invalid registrations are 400 validation_failed with field codes, create nothing, and echo nothing', async () => {
  const cases: Array<{ label: string; body: Record<string, unknown>; path: string; code: string; extra?: Record<string, unknown> }> = [
    { label: '14 characters', body: { password: 'a'.repeat(14) }, path: 'password', code: 'too_short', extra: { min: 15 } },
    { label: '129 characters', body: { password: 'a'.repeat(129) }, path: 'password', code: 'too_long', extra: { max: 128 } },
    { label: '14 emoji', body: { password: '😀'.repeat(14) }, path: 'password', code: 'too_short', extra: { min: 15 } },
    { label: 'blocklisted', body: { password: 'Password1234567890' }, path: 'password', code: 'password_common' },
    { label: 'bad email', body: { email: 'nope' }, path: 'email', code: 'invalid_email' },
    { label: 'empty name', body: { name: '  ' }, path: 'name', code: 'too_short', extra: { min: 1 } },
    { label: 'name too long', body: { name: 'n'.repeat(101) }, path: 'name', code: 'too_long', extra: { max: 100 } },
    { label: 'unknown key', body: { role: 'owner' }, path: '', code: 'unrecognized_key' },
  ];
  for (const c of cases) {
    const email = app.newEmail();
    const res = await app.post('/auth/register', { ...good(email), ...c.body });
    assert.equal(res.status, 400, c.label);
    assert.equal(res.body.error.code, 'validation_failed', c.label);
    const hit = res.body.error.details.find((d: { path: string; code: string }) => d.path === c.path && d.code === c.code);
    assert.ok(hit, `${c.label}: expected ${c.path}/${c.code}, got ${JSON.stringify(res.body.error.details)}`);
    for (const [k, v] of Object.entries(c.extra ?? {})) assert.equal(hit[k], v, `${c.label}: ${k}`);
    if (c.path !== 'email') assert.equal(await userCount(email), 0, `${c.label}: nothing created`);
    const echoed = String((c.body as { password?: string }).password ?? '');
    if (echoed.length > 14) assert.ok(!res.text.includes(echoed), `${c.label}: password echoed`);
  }
});

test('15 emoji are a valid password (length is counted in code points, not UTF-16 units)', async () => {
  const email = app.newEmail();
  assert.equal((await app.post('/auth/register', good(email, { password: '😀'.repeat(15) }))).status, 201);
});

test('malformed JSON, a wrong content type, a query string and an empty body are all 400', async () => {
  const bad = await app.post('/auth/register', '{"name": ', { 'content-type': 'application/json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_json');

  const plain = await app.post('/auth/register', JSON.stringify(good(app.newEmail())), { 'content-type': 'text/plain' });
  assert.equal(plain.status, 400);
  assert.equal(plain.body.error.code, 'validation_failed');

  const query = await app.post('/auth/register?admin=1', good(app.newEmail()));
  assert.equal(query.status, 400);
  assert.ok(query.body.error.details.some((d: { path: string; code: string }) => d.path === 'query' && d.code === 'unrecognized_key'));

  const empty = await app.post('/auth/register', {});
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body.error.details.map((d: { path: string }) => d.path).sort(), ['email', 'name', 'password']);
});

test('NFC: a password registered in decomposed form logs in when typed composed', async () => {
  const email = app.newEmail();
  const decomposed = 'café-au-lait-pour-tous';
  const composed = 'café-au-lait-pour-tous';
  assert.equal((await app.post('/auth/register', good(email, { password: decomposed }))).status, 201);
  assert.equal((await app.post('/auth/login', { email, password: composed })).status, 200);
  assert.equal((await app.post('/auth/login', { email, password: decomposed })).status, 200);
});

test('register is rate limited per IP: the limit is a 429 with Retry-After, and the extra attempt creates nothing', async () => {
  const limited = await startAuthTestApp({ rateLimits: { registerIp: { max: 2, windowSeconds: 60 } } });
  try {
    const emails = [limited.newEmail(), limited.newEmail(), limited.newEmail()];
    const codes = [];
    for (const e of emails) codes.push((await limited.post('/auth/register', good(e))).status);
    assert.deepEqual(codes, [201, 201, 429]);
    const third = await limited.post('/auth/register', good(limited.newEmail()));
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.equal(third.body.error.retryAfterSeconds, Number(third.headers.get('retry-after')));
    assert.equal(await limited.db.user.count({ where: { email: emails[2]! } }), 0);
  } finally {
    await limited.stop();
  }
});

test('with Valkey down, register fails closed (503) and creates no user', async () => {
  const down = await startAuthTestApp({ deadValkey: true });
  try {
    const email = down.newEmail();
    const res = await down.post('/auth/register', good(email));
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(await down.db.user.count({ where: { email } }), 0);
  } finally {
    await down.stop();
  }
});
