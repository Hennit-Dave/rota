import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EMAIL_SEND_TIMEOUT_MS, loadResendConfig, loadSenderConfig } from './mail.js';

test('the sender and reply-to come from MAIL_FROM and MAIL_REPLY_TO, with or without a display name', () => {
  assert.deepEqual(loadSenderConfig({ MAIL_FROM: 'Rota <notification@rota.davebuilds.design>', MAIL_REPLY_TO: 'rota@davebuilds.design' }), {
    from: 'Rota <notification@rota.davebuilds.design>',
    replyTo: 'rota@davebuilds.design',
  });
});

test('a missing or malformed sender stops the process: unset, blank, no @, header injection', () => {
  const ok = { MAIL_FROM: 'Rota <a@b.co>', MAIL_REPLY_TO: 'a@b.co' };
  assert.throws(() => loadSenderConfig({ MAIL_REPLY_TO: 'a@b.co' }), /MAIL_FROM is not set/);
  assert.throws(() => loadSenderConfig({ ...ok, MAIL_FROM: '   ' }), /MAIL_FROM is not set/);
  assert.throws(() => loadSenderConfig({ ...ok, MAIL_REPLY_TO: 'nobody' }), /MAIL_REPLY_TO must be an email address/);
  assert.throws(() => loadSenderConfig({ ...ok, MAIL_FROM: 'Rota <a@b.co>\r\nBcc: x@y.z' }), /MAIL_FROM must be an email address/);
});

test('the Resend key is required; the send timeout defaults to 10 s and rejects a bad override', () => {
  assert.throws(() => loadResendConfig({}), /RESEND_API_KEY is not set/);
  assert.deepEqual(loadResendConfig({ RESEND_API_KEY: ' re_x ' }), { apiKey: 're_x', timeoutMs: DEFAULT_EMAIL_SEND_TIMEOUT_MS });
  assert.equal(DEFAULT_EMAIL_SEND_TIMEOUT_MS, 10_000);
  assert.equal(loadResendConfig({ RESEND_API_KEY: 'k', EMAIL_SEND_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
  assert.throws(() => loadResendConfig({ RESEND_API_KEY: 'k', EMAIL_SEND_TIMEOUT_MS: '0' }), /EMAIL_SEND_TIMEOUT_MS/);
});
