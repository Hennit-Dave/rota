import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { DEFAULT_SETTINGS } from './service.js';

// Settings (ADR 0024; brief requirement 7: the server is the single source of truth, each setting has a server-set updatedAt, the most recent change wins;
// requirement 4: never trust the client). The TEST shards, real Valkey, real HTTP.
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp();
});
after(() => app.stop());

const db = () => app.raw.A.primary;

async function user(name = 'Amara Staff') {
  const u = await app.seedUser(name);
  return { ...u, h: bearer((await app.signIn(u.id)).accessToken) };
}
const rows = (userId: string) => db().$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM user_settings WHERE user_id = ${userId}::uuid`;

test('a user with no row gets the defaults, nothing is written by reading, and the answer is never cached', async () => {
  const u = await user();
  const res = await app.get('/settings', u.h);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body.settings, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  assert.equal((await rows(u.id)).length, 0, 'a GET never creates the row');
});

test('the DEFAULT_SETTINGS in the code are the column defaults in the database', async () => {
  const u = await user();
  await db().$executeRaw`INSERT INTO user_settings (user_id) VALUES (${u.id}::uuid)`;
  const res = await app.get('/settings', u.h);
  assert.deepEqual(res.body.settings, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
});

test('a change is stamped by the server, only on its own field, and the row holds the value', async () => {
  const u = await user();
  const before = Date.now();
  const res = await app.patch('/settings', { theme: 'dark' }, u.h);
  const after = Date.now();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body.settings;
  assert.equal(s.theme.value, 'dark');
  const stamp = Date.parse(s.theme.updatedAt);
  assert.ok(stamp >= before - 2000 && stamp <= after + 2000, 'the stamp is the server clock at the time of the request');
  for (const other of ['quietHours', 'timeZone', 'notifyShiftChanges', 'notifySwapUpdates', 'notifyBilling', 'language']) {
    assert.equal(s[other].updatedAt, null, `${other} was not changed`);
  }
  const row = (await rows(u.id))[0]!;
  assert.equal(row.theme, 'dark');
  assert.ok(row.theme_updated_at instanceof Date);
  assert.equal(row.quiet_hours_updated_at, null);
});

test('the client cannot choose the stamp, the user, or send two settings at once', async () => {
  const u = await user();
  const other = await user('Other User');
  const stampedByClient = await app.patch('/settings', { theme: 'dark', updatedAt: '2000-01-01T00:00:00.000Z' }, u.h);
  assert.equal(stampedByClient.status, 400);
  assert.equal(stampedByClient.body.error.code, 'validation_failed');
  assert.equal((await app.patch('/settings', { theme: 'dark', userId: other.id }, u.h)).status, 400);
  assert.equal((await app.patch('/settings', { theme: 'dark', language: 'en' }, u.h)).status, 400);
  assert.equal((await app.patch('/settings', {}, u.h)).status, 400);
  assert.equal((await rows(u.id)).length, 0, 'nothing was written by a refused request');
  assert.equal((await rows(other.id)).length, 0);
});

test('every refused value answers a 400 and writes nothing', async () => {
  const u = await user();
  const bads: unknown[] = [
    { theme: 'purple' },
    { language: 'fr' },
    { timeZone: 'Mars/Base' },
    { timeZone: null },
    { notifyBilling: 'yes' },
    { quietHours: { enabled: true, start: '22:00', end: '22:00' } },
    { quietHours: { enabled: true, start: '25:00', end: '06:00' } },
    { quietHours: { enabled: true, start: '22:00', end: '06:00', extra: 1 } },
  ];
  for (const body of bads) assert.equal((await app.patch('/settings', body, u.h)).status, 400, JSON.stringify(body));
  assert.equal((await rows(u.id)).length, 0);
});

test('per field: a theme change and a quiet-hours change, in either order, both survive (interview question 6, the server half)', async () => {
  const u = await user();
  assert.equal((await app.patch('/settings', { theme: 'dark' }, u.h)).status, 200); // "the phone"
  const res = await app.patch('/settings', { quietHours: { enabled: true, start: '22:00', end: '07:00' } }, u.h); // "the tablet"
  assert.equal(res.status, 200);
  const s = res.body.settings;
  assert.equal(s.theme.value, 'dark', 'the quiet-hours change did not undo the theme');
  assert.deepEqual(s.quietHours.value, { enabled: true, start: '22:00', end: '07:00' });
  assert.ok(s.theme.updatedAt && s.quietHours.updatedAt);
  assert.ok(Date.parse(s.quietHours.updatedAt) >= Date.parse(s.theme.updatedAt), 'each field has its own stamp, the later change has the later one');
});

test('the same field: the later arrival wins, and its stamp is later', async () => {
  const u = await user();
  const first = await app.patch('/settings', { quietHours: { enabled: true, start: '21:00', end: '05:00' } }, u.h); // the phone
  await new Promise((r) => setTimeout(r, 25));
  const second = await app.patch('/settings', { quietHours: { enabled: true, start: '23:00', end: '08:00' } }, u.h); // the tablet
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(Date.parse(second.body.settings.quietHours.updatedAt) > Date.parse(first.body.settings.quietHours.updatedAt));
  const read = await app.get('/settings', u.h);
  assert.deepEqual(read.body.settings.quietHours.value, { enabled: true, start: '23:00', end: '08:00' }, 'what arrived last stands');
});

test('quiet hours may cross midnight and are kept as typed, a time zone is validated and stored', async () => {
  const u = await user();
  const res = await app.patch('/settings', { quietHours: { enabled: true, start: '22:00', end: '06:00' } }, u.h);
  assert.deepEqual(res.body.settings.quietHours.value, { enabled: true, start: '22:00', end: '06:00' });
  const tz = await app.patch('/settings', { timeZone: 'Africa/Lagos' }, u.h);
  assert.deepEqual(tz.body.settings.timeZone.value, 'Africa/Lagos');
  const off = await app.patch('/settings', { quietHours: { enabled: false, start: '22:00', end: '06:00' } }, u.h);
  assert.equal(off.body.settings.quietHours.value.enabled, false);
  const row = (await rows(u.id))[0]!;
  assert.equal(row.time_zone, 'Africa/Lagos');
});

test('notification types are three independent switches', async () => {
  const u = await user();
  await app.patch('/settings', { notifyShiftChanges: false }, u.h);
  await app.patch('/settings', { notifyBilling: false }, u.h);
  const s = (await app.get('/settings', u.h)).body.settings;
  assert.deepEqual([s.notifyShiftChanges.value, s.notifySwapUpdates.value, s.notifyBilling.value], [false, true, false]);
  assert.ok(s.notifyShiftChanges.updatedAt && s.notifyBilling.updatedAt);
  assert.equal(s.notifySwapUpdates.updatedAt, null);
});

test("one user's change never reaches another's settings", async () => {
  const a = await user('User A');
  const b = await user('User B');
  await app.patch('/settings', { theme: 'dark', }, a.h);
  const seenByB = await app.get('/settings', b.h);
  assert.equal(seenByB.body.settings.theme.value, 'system');
  assert.equal((await rows(b.id)).length, 0);
});

test('no token, a garbage token and a session that was revoked are all 401, and nothing is written', async () => {
  const none = await app.get('/settings');
  assert.equal(none.status, 401);
  assert.equal((await app.patch('/settings', { theme: 'dark' })).status, 401);
  assert.equal((await app.patch('/settings', { theme: 'dark' }, bearer('not-a-token'))).status, 401);

  const u = await user();
  await db().$executeRaw`UPDATE refresh_token_families SET revoked_at = NOW(), revoked_reason = 'logout' WHERE user_id = ${u.id}::uuid`;
  const revoked = await app.patch('/settings', { theme: 'dark' }, u.h);
  assert.equal(revoked.status, 401, 'the session check applies to settings like every other user route');
  assert.equal((await rows(u.id)).length, 0);
});

test('a malformed route is the usual 404, and the production app serves /settings too', async () => {
  const u = await user();
  assert.equal((await app.get(`/settings/${randomUUID()}`, u.h)).status, 404);
  const res = await fetch(`${app.productionBase}/settings`, { headers: u.h });
  assert.equal(res.status, 200);
});

test('deleting a user deletes their settings', async () => {
  const u = await user();
  await app.patch('/settings', { theme: 'light' }, u.h);
  assert.equal((await rows(u.id)).length, 1);
  await db().user.delete({ where: { id: u.id } });
  assert.equal((await rows(u.id)).length, 0);
});

test('rate limits: writes and reads are limited per user, and a blocked request writes nothing', async () => {
  const limited = await startTeamsTestApp({ rateLimits: { settingsWriteUser: { max: 2, windowSeconds: 60 }, settingsReadUser: { max: 2, windowSeconds: 60 } } });
  try {
    const u = await limited.seedUser('Limited');
    const h = bearer((await limited.signIn(u.id)).accessToken);
    assert.equal((await limited.patch('/settings', { theme: 'dark' }, h)).status, 200);
    assert.equal((await limited.patch('/settings', { theme: 'light' }, h)).status, 200);
    const blocked = await limited.patch('/settings', { theme: 'system' }, h);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    const row = (await limited.raw.A.primary.$queryRaw<Array<{ theme: string }>>`SELECT theme FROM user_settings WHERE user_id = ${u.id}::uuid`)[0]!;
    assert.equal(row.theme, 'light', 'the blocked change was not applied');
    assert.equal((await limited.get('/settings', h)).status, 200);
    assert.equal((await limited.get('/settings', h)).status, 200);
    assert.equal((await limited.get('/settings', h)).status, 429);
  } finally {
    await limited.stop();
  }
});

test('Valkey down: the limited settings routes fail closed with 503 instead of skipping the limit', async () => {
  const dead = await startTeamsTestApp({ deadValkey: true });
  try {
    const u = await dead.seedUser('No Valkey');
    const h = bearer((await dead.signIn(u.id)).accessToken);
    assert.equal((await dead.get('/settings', h)).status, 503);
    assert.equal((await dead.patch('/settings', { theme: 'dark' }, h)).status, 503);
  } finally {
    await dead.stop();
  }
});
