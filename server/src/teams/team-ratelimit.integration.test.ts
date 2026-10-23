import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearer, startTeamsTestApp } from './testkit.js';

test('POST /teams is limited to 5 per user per hour: the sixth is 429 with Retry-After and creates nothing', async () => {
  const app = await startTeamsTestApp();
  try {
    assert.deepEqual(app.config.rateLimits.teamCreateUser, { max: 5, windowSeconds: 3600 });
    const user = await app.seedUser();
    const other = await app.seedUser();
    const h = bearer((await app.signIn(user.id)).accessToken);
    const body = { name: 'Limited', timeZone: 'Africa/Lagos' };

    for (let i = 1; i <= 5; i++) assert.equal((await app.post('/teams', body, h)).status, 201, `create ${i}`);
    const directoryBefore = await app.raw.A.primary.userTeam.count({ where: { userId: user.id } });
    assert.equal(directoryBefore, 5);

    const sixth = await app.post('/teams', body, h);
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error.code, 'rate_limited');
    assert.ok(Number(sixth.headers.get('retry-after')) >= 1);
    assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: user.id } }), 5, 'the blocked request wrote nothing');

    // The limit is per user: another user is not affected, and reading is not limited.
    const otherHeaders = bearer((await app.signIn(other.id)).accessToken);
    assert.equal((await app.post('/teams', body, otherHeaders)).status, 201);
    assert.equal((await app.get('/teams', h)).status, 200);
  } finally {
    await app.stop();
  }
});

test('with Valkey down, POST /teams fails CLOSED: 503 and nothing is written', async () => {
  const app = await startTeamsTestApp({ deadValkey: true });
  try {
    const user = await app.seedUser();
    const h = bearer((await app.signIn(user.id)).accessToken);
    const res = await app.post('/teams', { name: 'Never', timeZone: 'Africa/Lagos' }, h);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(await app.raw.A.primary.userTeam.count({ where: { userId: user.id } }), 0);
    assert.equal((await app.get('/teams', h)).status, 200, 'reads do not depend on Valkey');
  } finally {
    await app.stop();
  }
});
