import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAuthConfig, loadJwtSecret } from './config.js';

test('defaults are exactly the numbers Dave approved on 2026-10-21', () => {
  const c = loadAuthConfig({});
  assert.equal(c.accessTokenMinutes, 15);
  assert.equal(c.refreshIdleDays, 30);
  assert.equal(c.sessionAbsoluteDays, 90);
  assert.equal(c.clockSkewSeconds, 0);
  assert.equal(c.transactionMaxWaitMs, 5000);
  assert.deepEqual(c.password, { minLength: 15, maxLength: 128 });
  assert.deepEqual(c.rateLimits.loginIp, { max: 30, windowSeconds: 900 });
  assert.deepEqual(c.rateLimits.loginEmail, { max: 5, windowSeconds: 900 });
  assert.deepEqual(c.rateLimits.registerIp, { max: 10, windowSeconds: 3600 });
  assert.deepEqual(c.rateLimits.refreshIp, { max: 60, windowSeconds: 900 });
  assert.deepEqual(c.rateLimits.teamCreateUser, { max: 5, windowSeconds: 3600 });
});

test('env overrides apply', () => {
  const c = loadAuthConfig({ AUTH_ACCESS_TOKEN_MINUTES: '5', RATE_LIMIT_LOGIN_EMAIL_MAX: '2', RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS: '60' });
  assert.equal(c.accessTokenMinutes, 5);
  assert.deepEqual(c.rateLimits.loginEmail, { max: 2, windowSeconds: 60 });
});

test('the transaction wait is configurable, and a bad value stops the server', () => {
  assert.equal(loadAuthConfig({ AUTH_TRANSACTION_MAX_WAIT_MS: '8000' }).transactionMaxWaitMs, 8000);
  assert.throws(() => loadAuthConfig({ AUTH_TRANSACTION_MAX_WAIT_MS: '0' }), /AUTH_TRANSACTION_MAX_WAIT_MS/);
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

test('invite settings: 7 days, 50 invite emails per UTC day app-wide, the production link host, and the approved limits', () => {
  const c = loadAuthConfig({});
  // Invite links (ADR 0025, approved 2026-10-28): 48 hours, at most 10 pending per team; their limits mirror the email invites'.
  assert.deepEqual(c.invites, { expiryDays: 7, linkExpiryHours: 48, linkMaxPending: 10, globalDailyCap: 50, linkBaseUrl: 'https://rota.davebuilds.design' });
  assert.deepEqual(c.rateLimits.inviteLinkUser, { max: 10, windowSeconds: 3600 });
  assert.deepEqual(c.rateLimits.inviteLinkTeam, { max: 20, windowSeconds: 86_400 });
  assert.deepEqual(c.rateLimits.inviteSendUser, { max: 10, windowSeconds: 3600 });
  assert.deepEqual(c.rateLimits.inviteSendTeam, { max: 20, windowSeconds: 86_400 });
  assert.deepEqual(c.rateLimits.invitePreviewIp, { max: 30, windowSeconds: 900 });
  assert.deepEqual(c.rateLimits.inviteAcceptUser, { max: 10, windowSeconds: 3600 });
  assert.deepEqual(c.rateLimits.inviteAcceptIp, { max: 30, windowSeconds: 900 });
});

test('invite overrides apply, and a bad value stops the server', () => {
  const c = loadAuthConfig({ INVITE_EXPIRY_DAYS: '3', INVITE_GLOBAL_DAILY_CAP: '5', INVITE_LINK_BASE_URL: 'https://example.test/' });
  assert.deepEqual(c.invites, { expiryDays: 3, linkExpiryHours: 48, linkMaxPending: 10, globalDailyCap: 5, linkBaseUrl: 'https://example.test' });
  const links = loadAuthConfig({ INVITE_LINK_EXPIRY_HOURS: '24', INVITE_LINK_MAX_PENDING: '3' });
  assert.deepEqual([links.invites.linkExpiryHours, links.invites.linkMaxPending], [24, 3]);
  assert.throws(() => loadAuthConfig({ INVITE_LINK_EXPIRY_HOURS: '0' }), /INVITE_LINK_EXPIRY_HOURS/);
  assert.throws(() => loadAuthConfig({ INVITE_LINK_MAX_PENDING: 'ten' }), /INVITE_LINK_MAX_PENDING/);
  assert.throws(() => loadAuthConfig({ INVITE_EXPIRY_DAYS: '0' }), /INVITE_EXPIRY_DAYS/);
  assert.throws(() => loadAuthConfig({ INVITE_GLOBAL_DAILY_CAP: 'many' }), /INVITE_GLOBAL_DAILY_CAP/);
  for (const bad of ['http://rota.davebuilds.design', 'https://rota.davebuilds.design/invite', 'https://rota.davebuilds.design/?x=1', 'https://u:p@rota.davebuilds.design', 'not a url']) {
    assert.throws(() => loadAuthConfig({ INVITE_LINK_BASE_URL: bad }), /INVITE_LINK_BASE_URL/, bad);
  }
});
