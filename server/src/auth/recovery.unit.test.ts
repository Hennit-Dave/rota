import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAuthConfig } from './config.js';
import { createBlocklist } from './blocklist.js';
import { describeMinutes, renderRecoveryEmail } from './recoveryEmail.js';
import { hashRecoverySecret, issueRecoverySecret, parseRecoverySecret } from './recoveryTokens.js';
import { createAuthSchemas } from './schemas.js';

test('a recovery secret is 43 base64url characters, unique, and only its SHA-256 identifies it', () => {
  const a = issueRecoverySecret();
  const b = issueRecoverySecret();
  assert.match(a.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.secret, b.secret);
  assert.equal(a.tokenHash.length, 32);
  assert.deepEqual(a.tokenHash, hashRecoverySecret(a.secret));
  assert.deepEqual(parseRecoverySecret(a.secret), a.tokenHash);
});

test('parseRecoverySecret accepts only exactly the shape we issue', () => {
  for (const bad of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}!`, ` ${'A'.repeat(43)}`, `${'A'.repeat(43)}\n`]) {
    assert.equal(parseRecoverySecret(bad), null, JSON.stringify(bad));
  }
  assert.notEqual(parseRecoverySecret('A'.repeat(43)), null);
});

test('approved defaults: magic link 10 minutes, reset 1 hour, daily cap 30, request limits per email 5 and per IP 30 per 15 minutes', () => {
  const c = loadAuthConfig({});
  assert.equal(c.magicLinkMinutes, 10);
  assert.equal(c.passwordResetMinutes, 60);
  assert.equal(c.recovery.globalDailyCap, 30);
  assert.deepEqual(c.rateLimits.magicRequestEmail, { max: 5, windowSeconds: 900 });
  assert.deepEqual(c.rateLimits.resetRequestEmail, { max: 5, windowSeconds: 900 });
  for (const rule of [c.rateLimits.magicRequestIp, c.rateLimits.resetRequestIp, c.rateLimits.magicRedeemIp, c.rateLimits.resetSubmitIp]) {
    assert.deepEqual(rule, { max: 30, windowSeconds: 900 });
  }
});

test('the recovery settings can be overridden by env, and a bad value stops the server instead of weakening it', () => {
  const c = loadAuthConfig({ AUTH_MAGIC_LINK_MINUTES: '5', AUTH_PASSWORD_RESET_MINUTES: '30', AUTH_EMAIL_GLOBAL_DAILY_CAP: '7', RATE_LIMIT_RESET_SUBMIT_IP_MAX: '3' });
  assert.equal(c.magicLinkMinutes, 5);
  assert.equal(c.passwordResetMinutes, 30);
  assert.equal(c.recovery.globalDailyCap, 7);
  assert.equal(c.rateLimits.resetSubmitIp.max, 3);
  for (const name of ['AUTH_MAGIC_LINK_MINUTES', 'AUTH_PASSWORD_RESET_MINUTES', 'AUTH_EMAIL_GLOBAL_DAILY_CAP', 'RATE_LIMIT_MAGIC_REDEEM_IP_MAX']) {
    assert.throws(() => loadAuthConfig({ [name]: '0' }), new RegExp(name));
    assert.throws(() => loadAuthConfig({ [name]: 'ten' }), new RegExp(name));
  }
});

test('describeMinutes reads naturally', () => {
  assert.equal(describeMinutes(10), '10 minutes');
  assert.equal(describeMinutes(1), '1 minute');
  assert.equal(describeMinutes(60), '1 hour');
  assert.equal(describeMinutes(120), '2 hours');
  assert.equal(describeMinutes(90), '90 minutes');
});

const base = {
  from: 'Rota <notification@rota.davebuilds.design>',
  replyTo: 'rota@davebuilds.design',
  to: 'sofia@example.com',
  link: 'https://rota.davebuilds.design/reset/' + 'A'.repeat(43),
  authTokenId: '11111111-1111-4111-8111-111111111111',
  tokenHashHex: 'ab'.repeat(32),
};

test('the reset email: subject, the link in both parts, the relative expiry, and the ids the email job needs', () => {
  const mail = renderRecoveryEmail({ ...base, purpose: 'password_reset', minutes: 60 });
  assert.equal(mail.subject, 'Reset your Rota password');
  assert.deepEqual(mail.to, ['sofia@example.com']);
  assert.equal(mail.from, base.from);
  assert.equal(mail.replyTo, base.replyTo);
  assert.ok(mail.text.includes(base.link));
  assert.ok(mail.html.includes(`href="${base.link}"`));
  assert.ok(mail.text.includes('This link expires in 1 hour.'));
  assert.ok(mail.text.includes("If you didn't ask to reset your password"));
  assert.equal(mail.authTokenId, base.authTokenId);
  assert.equal(mail.tokenHashHex, base.tokenHashHex);
});

test('the magic-link email says it signs you in, works once, and expires in 10 minutes', () => {
  const mail = renderRecoveryEmail({ ...base, link: 'https://rota.davebuilds.design/magic/' + 'B'.repeat(43), purpose: 'magic_link', minutes: 10 });
  assert.equal(mail.subject, 'Your Rota sign-in link');
  assert.ok(mail.text.includes('It works once.'));
  assert.ok(mail.text.includes('This link expires in 10 minutes.'));
  assert.ok(mail.text.includes("If you didn't ask for this link"));
});

test('the email escapes what it inserts into HTML', () => {
  const mail = renderRecoveryEmail({ ...base, purpose: 'magic_link', minutes: 10, link: 'https://rota.davebuilds.design/magic/x"><script>alert(1)</script>' });
  assert.equal(mail.html.includes('<script>'), false);
  assert.ok(mail.html.includes('&quot;&gt;&lt;script&gt;'));
});

test('the reset password follows the signup policy (length, blocklist), and the request and redeem bodies are strict', () => {
  const schemas = createAuthSchemas(loadAuthConfig({}), createBlocklist(['password1234567']));
  const token = 'A'.repeat(43);
  assert.equal(schemas.resetSubmit.safeParse({ token, password: 'short' }).success, false);
  assert.equal(schemas.resetSubmit.safeParse({ token, password: 'password1234567' }).success, false, 'common password');
  assert.equal(schemas.resetSubmit.safeParse({ token, password: 'a-good-long-passphrase-1' }).success, true);
  assert.equal(schemas.resetSubmit.safeParse({ token, password: 'a-good-long-passphrase-1', extra: 1 }).success, false);
  assert.equal(schemas.recoveryRequest.safeParse({ email: ' Sofia@Example.com ' }).data?.email, 'sofia@example.com');
  assert.equal(schemas.recoveryRequest.safeParse({ email: 'x@example.com', extra: 1 }).success, false);
  assert.equal(schemas.magicRedeem.safeParse({ token }).success, true);
  assert.equal(schemas.magicRedeem.safeParse({ token: '' }).success, false);
});
