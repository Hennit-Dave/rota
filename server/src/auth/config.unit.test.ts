import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAuthConfig, loadJwtSecret } from './config.js';

test('defaults are exactly the numbers Dave approved on 2026-10-21', () => {
  const c = loadAuthConfig({});
  assert.equal(c.accessTokenMinutes, 15);
  assert.equal(c.refreshIdleDays, 30);
  assert.equal(c.sessionAbsoluteDays, 90);
  assert.equal(c.clockSkewSeconds, 0);
  assert.deepEqual(c.password, { minLength: 15, maxLength: 128 });
  assert.deepEqual(c.rateLimits.loginIp, { max: 30, windowSeconds: 900 });
  assert.deepEqual(c.rateLimits.loginEmail, { max: 5, windowSeconds: 900 });
  assert.deepEqual(c.rateLimits.registerIp, { max: 10, windowSeconds: 3600 });
  assert.deepEqual(c.rateLimits.refreshIp, { max: 60, windowSeconds: 900 });
});

test('env overrides apply', () => {
  const c = loadAuthConfig({ AUTH_ACCESS_TOKEN_MINUTES: '5', RATE_LIMIT_LOGIN_EMAIL_MAX: '2', RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS: '60' });
  assert.equal(c.accessTokenMinutes, 5);
  assert.deepEqual(c.rateLimits.loginEmail, { max: 2, windowSeconds: 60 });
});

test('a set-but-invalid value stops the server instead of silently weakening a security setting', () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '15m', ' 15']) {
    assert.throws(() => loadAuthConfig({ AUTH_ACCESS_TOKEN_MINUTES: bad }), /AUTH_ACCESS_TOKEN_MINUTES/, bad);
  }
  assert.throws(() => loadAuthConfig({ RATE_LIMIT_LOGIN_IP_MAX: '0' }), /RATE_LIMIT_LOGIN_IP_MAX/);
  assert.equal(loadAuthConfig({ AUTH_ACCESS_TOKEN_MINUTES: '' }).accessTokenMinutes, 15, 'empty means unset');
});

test('JWT secret: required, base64, at least 32 bytes', () => {
  assert.throws(() => loadJwtSecret({}), /not set/);
  assert.throws(() => loadJwtSecret({ AUTH_JWT_SECRET: 'not base64 !!!' }), /base64/);
  assert.throws(() => loadJwtSecret({ AUTH_JWT_SECRET: Buffer.alloc(31, 7).toString('base64') }), /at least 32 bytes/);
  const ok = loadJwtSecret({ AUTH_JWT_SECRET: Buffer.alloc(32, 7).toString('base64') });
  assert.equal(ok.length, 32);
  assert.equal(loadJwtSecret({ AUTH_JWT_SECRET: Buffer.alloc(64, 9).toString('base64') }).length, 64);
});

test('a bad secret error never contains the secret', () => {
  const short = Buffer.alloc(8, 5).toString('base64');
  try {
    loadJwtSecret({ AUTH_JWT_SECRET: short });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!String((e as Error).message).includes(short));
  }
});
