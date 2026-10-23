import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyResendFailure, createResendClient, ResendError } from './resend.js';

const payload = {
  from: 'Rota <notification@rota.davebuilds.design>',
  replyTo: 'rota@davebuilds.design',
  to: ['delivered@resend.dev'],
  subject: 'Subject',
  html: '<p>html</p>',
  text: 'text',
};

function client(respond: (req: { url: string; init: RequestInit }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const c = createResendClient({
    apiKey: 're_test_key_not_real',
    timeoutMs: 1000,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond({ url, init });
    }) as unknown as typeof fetch,
  });
  return { c, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('the request: POST /emails with the bearer key, the Idempotency-Key, and Resend\'s field names (reply_to, not replyTo)', async () => {
  const { c, calls } = client(() => json(200, { id: 'msg_123' }));
  const sent = await c.send({ payload, idempotencyKey: 'email-abc' });
  assert.deepEqual(sent, { id: 'msg_123' });
  assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
  assert.equal(calls[0]!.init.method, 'POST');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer re_test_key_not_real');
  assert.equal(headers['Idempotency-Key'], 'email-abc');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    from: payload.from,
    to: payload.to,
    subject: 'Subject',
    html: '<p>html</p>',
    text: 'text',
    reply_to: 'rota@davebuilds.design',
  });
});

test('classification: what is worth retrying with the same key, and what is not', () => {
  const kind = (status: number, name?: string) => classifyResendFailure(status, name).kind;
  // retryable
  assert.equal(kind(500), 'retryable');
  assert.equal(kind(503, 'service_unavailable'), 'retryable');
  assert.equal(kind(429, 'rate_limit_exceeded'), 'retryable');
  assert.equal(kind(429), 'retryable');
  assert.equal(kind(409, 'concurrent_idempotent_requests'), 'retryable');
  // terminal: a retry cannot help
  assert.equal(kind(429, 'daily_quota_exceeded'), 'terminal', 'resets at midnight UTC: do not burn the attempt budget');
  assert.equal(kind(429, 'monthly_quota_exceeded'), 'terminal');
  assert.equal(kind(409, 'invalid_idempotent_request'), 'terminal');
  for (const status of [400, 401, 403, 404, 422]) assert.equal(kind(status), 'terminal', String(status));
  assert.equal(kind(401, 'missing_api_key'), 'terminal');
  assert.equal(kind(403, 'restricted_api_key'), 'terminal');
});

test('a 429 keeps Resend\'s retry-after so the retry can honour it', async () => {
  const { c } = client(() => json(429, { name: 'rate_limit_exceeded', message: 'x' }, { 'retry-after': '3' }));
  await assert.rejects(c.send({ payload, idempotencyKey: 'k' }), (e: unknown) => {
    assert.ok(e instanceof ResendError);
    assert.equal(e.kind, 'retryable');
    assert.equal(e.retryAfterSeconds, 3);
    return true;
  });
});

test('network errors and timeouts are retryable; an unreadable success answer is retryable (the key makes the retry safe)', async () => {
  const net = createResendClient({ apiKey: 'k', timeoutMs: 1000, fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
  await assert.rejects(net.send({ payload, idempotencyKey: 'k' }), (e: unknown) => e instanceof ResendError && e.kind === 'retryable' && e.reason === 'network_error');

  const slow = createResendClient({
    apiKey: 'k',
    timeoutMs: 20,
    fetch: ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch,
  });
  await assert.rejects(slow.send({ payload, idempotencyKey: 'k' }), (e: unknown) => e instanceof ResendError && e.kind === 'retryable' && e.reason === 'timeout');

  const { c } = client(() => json(200, { nope: true }));
  await assert.rejects(c.send({ payload, idempotencyKey: 'k' }), (e: unknown) => e instanceof ResendError && e.kind === 'retryable' && e.reason === 'unreadable_success_response');
});

test('an error never carries the recipient, the link, the key or the response body', async () => {
  const { c } = client(() => json(422, { name: 'validation_error', message: 'The to field sofia@example.com is invalid https://rota.davebuilds.design/invite/x.y' }));
  await assert.rejects(c.send({ payload: { ...payload, to: ['sofia@example.com'] }, idempotencyKey: 'k' }), (e: unknown) => {
    assert.ok(e instanceof ResendError);
    assert.ok(!/sofia|example|invite|re_test_key/.test(e.message), e.message);
    return true;
  });
});
