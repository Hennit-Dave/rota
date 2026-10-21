import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { hashRefreshToken } from './sessions.js';
import { bearer, startAuthTestApp, type TestApp } from './testkit.js';

let app: TestApp;
before(async () => {
  app = await startAuthTestApp();
});
after(() => app.stop());

const refresh = (refreshToken: string) => app.post('/auth/refresh', { refreshToken });

const expect401 = (r: { status: number; body: any; headers: Headers }) => {
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'unauthenticated');
  assert.equal(r.headers.get('www-authenticate'), 'Bearer');
};

/** The `reason` of the most recent request_rejected log line: how the server (not the caller) tells refusals apart. */
const lastReason = () => {
  const lines = app.logLines().map((l) => JSON.parse(l) as Record<string, unknown>);
  return lines.filter((l) => l.msg === 'request_rejected').at(-1)?.reason;
};

async function user() {
  const u = await app.seedUser();
  return { u, s: await app.startSession(u.id) };
}

test('rotation: a refresh returns a NEW refresh token and a working access token; the old token stops working', async () => {
  const { u, s } = await user();
  const res = await refresh(s.refreshToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(res.body).sort(), ['session']);
  assert.deepEqual(Object.keys(res.body.session).sort(), ['accessToken', 'accessTokenExpiresAt', 'refreshToken']);
  assert.notEqual(res.body.session.refreshToken, s.refreshToken);

  const me = await app.get('/auth/me', bearer(res.body.session.accessToken));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, u.id);
  assert.equal((await app.tokens.verify(res.body.session.accessToken)).familyId, s.familyId, 'same session, new tokens');

  // The old token is now "used": presenting it again is reuse (tested in depth below).
  expect401(await refresh(s.refreshToken));
});

test('rotation chain: each new token works exactly once, and the database holds only hashes', async () => {
  const { s } = await user();
  const first = await refresh(s.refreshToken);
  const second = await refresh(first.body.session.refreshToken);
  const third = await refresh(second.body.session.refreshToken);
  assert.equal(third.status, 200);

  const rows = await app.db.refreshToken.findMany({ where: { familyId: s.familyId }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, 4, 'the original plus three replacements');
  assert.equal(rows.filter((r) => r.usedAt === null).length, 1, 'exactly one live token per family');
  const raw = [s.refreshToken, first, second, third].map((x) => (typeof x === 'string' ? x : x.body.session.refreshToken));
  for (const token of raw) {
    assert.ok(rows.some((r) => Buffer.from(r.tokenHash).equals(Buffer.from(hashRefreshToken(token)))), 'stored as SHA-256');
    assert.ok(!rows.some((r) => Buffer.from(r.tokenHash).toString('base64url') === token), 'never stored raw');
  }
});

test('every failure is the same 401 body; only the server log knows why', async () => {
  const strip = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });

  const unknown = await refresh(randomBytes(32).toString('base64url'));
  expect401(unknown);
  assert.equal(lastReason(), 'refresh_unknown_token');

  const idle = await user();
  await app.db.refreshToken.updateMany({ where: { familyId: idle.s.familyId }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
  const idleRes = await refresh(idle.s.refreshToken);
  expect401(idleRes);
  assert.equal(lastReason(), 'refresh_idle_expired');
  assert.equal((await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: idle.s.familyId } })).revokedAt, null, 'an idle-expired token is not theft');

  const expired = await user();
  await app.db.refreshTokenFamily.update({ where: { id: expired.s.familyId }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
  const expiredRes = await refresh(expired.s.refreshToken);
  expect401(expiredRes);
  assert.equal(lastReason(), 'refresh_family_expired');

  const revoked = await user();
  await app.db.refreshTokenFamily.update({ where: { id: revoked.s.familyId }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
  const revokedRes = await refresh(revoked.s.refreshToken);
  expect401(revokedRes);
  assert.equal(lastReason(), 'refresh_family_revoked');
  assert.equal((await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: revoked.s.familyId } })).revokedReason, 'logout', 'the first reason is kept');

  for (const r of [idleRes, expiredRes, revokedRes]) assert.deepEqual(strip(r), strip(unknown), 'indistinguishable bodies');
});

test('the new token cannot outlive the family: its idle expiry is capped at the absolute expiry', async () => {
  const { s } = await user();
  const absolute = new Date(Date.now() + 2 * 86_400_000);
  await app.db.refreshTokenFamily.update({ where: { id: s.familyId }, data: { absoluteExpiresAt: absolute } });
  const res = await refresh(s.refreshToken);
  assert.equal(res.status, 200);
  const next = await app.db.refreshToken.findFirstOrThrow({ where: { familyId: s.familyId, usedAt: null } });
  assert.equal(next.idleExpiresAt.getTime(), absolute.getTime());
});

test('REUSE (#6): an old token revokes the family and COMMITS it before the 401; other devices keep working', async () => {
  const phone = await user();
  const tablet = await app.startSession(phone.u.id);

  const rotated = await refresh(phone.s.refreshToken);
  assert.equal(rotated.status, 200);
  const newest = rotated.body.session as { accessToken: string; refreshToken: string };
  assert.equal((await app.get('/auth/me', bearer(newest.accessToken))).status, 200, 'before the replay everything works');

  // The thief replays the OLD token.
  const replay = await refresh(phone.s.refreshToken);
  expect401(replay);
  assert.equal(lastReason(), 'refresh_reuse_detected');

  // Committed: visible from a separate read right now, with the reason recorded.
  const family = await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: phone.s.familyId } });
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, 'reuse_detected');

  // The legitimate holder's newest refresh token and access tokens are dead on their next use.
  expect401(await refresh(newest.refreshToken));
  expect401(await app.get('/auth/me', bearer(newest.accessToken)));
  expect401(await app.get('/auth/me', bearer(phone.s.accessToken)));

  // Another device of the same user is untouched.
  assert.equal((await app.get('/auth/me', bearer(tablet.accessToken))).status, 200);
  assert.equal((await refresh(tablet.refreshToken)).status, 200);
  assert.equal((await app.db.refreshTokenFamily.findUniqueOrThrow({ where: { id: tablet.familyId } })).revokedAt, null);

  // The security event names the user and family, and nothing secret.
  const event = app.logLines().map((l) => JSON.parse(l)).find((l) => l.msg === 'refresh_reuse_detected' && l.familyId === phone.s.familyId);
  assert.ok(event);
  assert.equal(event.userId, phone.u.id);
});

test('validation: a body that is not exactly { refreshToken: <our token shape> } is a 400 that never echoes the input', async () => {
  const junk = 'x'.repeat(40) + '<script>';
  const cases: unknown[] = [{}, { refreshToken: 5 }, { refreshToken: 'short' }, { refreshToken: junk }, { refreshToken: randomBytes(32).toString('base64url'), extra: 1 }];
  for (const body of cases) {
    const res = await app.post('/auth/refresh', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(!res.text.includes('<script>'), 'the submitted value is never echoed');
  }
  const q = await app.post(`/auth/refresh?x=1`, { refreshToken: randomBytes(32).toString('base64url') });
  assert.equal(q.status, 400);
});

test('rate limit: over the limit is a 429 with Retry-After, answered BEFORE the token is touched', async () => {
  const limited = await startAuthTestApp({ rateLimits: { refreshIp: { max: 2, windowSeconds: 60 } } });
  try {
    const u = await limited.seedUser();
    const s = await limited.startSession(u.id);
    const junk = () => limited.post('/auth/refresh', { refreshToken: randomBytes(32).toString('base64url') });
    expect401(await junk());
    expect401(await junk());

    const blocked = await limited.post('/auth/refresh', { refreshToken: s.refreshToken });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const row = await limited.db.refreshToken.findFirstOrThrow({ where: { familyId: s.familyId } });
    assert.equal(row.usedAt, null, 'a blocked request did not consume the token');
  } finally {
    await limited.stop();
  }
});

test('Valkey down: refresh fails closed with 503 and consumes nothing', async () => {
  const dead = await startAuthTestApp({ deadValkey: true });
  try {
    const u = await dead.seedUser();
    const s = await dead.startSession(u.id);
    const res = await dead.post('/auth/refresh', { refreshToken: s.refreshToken });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    const row = await dead.db.refreshToken.findFirstOrThrow({ where: { familyId: s.familyId } });
    assert.equal(row.usedAt, null);
  } finally {
    await dead.stop();
  }
});

test('redaction: refresh and reuse put no token (refresh or access) in any log line', async () => {
  const { s } = await user();
  const first = await refresh(s.refreshToken);
  await refresh(s.refreshToken); // reuse
  const secrets = [s.refreshToken, s.accessToken, first.body.session.refreshToken, first.body.session.accessToken];
  const logs = app.logLines().join('\n');
  for (const secret of secrets) assert.ok(!logs.includes(secret), 'a token reached the log');
  assert.ok(logs.includes('/auth/refresh'), 'the route template is logged');
});
