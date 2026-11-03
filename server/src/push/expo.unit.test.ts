import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyExpoFailure, createExpoPushClient, ExpoPushError, MAX_MESSAGES_PER_REQUEST } from './expo.js';
import type { ExpoMessage } from './expo.js';

const message = (to = 'ExponentPushToken[abc]'): ExpoMessage => ({
  to,
  title: 't',
  body: 'b',
  data: { v: 1, type: 'billing', moment: 'renewal_failed', teamId: '00000000-0000-4000-8000-000000000000' },
  channelId: 'default',
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('failures are classified once: 429 and 5xx retry, 400 and other 4xx do not (Expo: a 400 is not retriable)', () => {
  assert.equal(classifyExpoFailure(429).kind, 'retryable');
  assert.equal(classifyExpoFailure(500).kind, 'retryable');
  assert.equal(classifyExpoFailure(503).kind, 'retryable');
  assert.equal(classifyExpoFailure(400).kind, 'terminal');
  assert.equal(classifyExpoFailure(401).kind, 'terminal');
  assert.equal(classifyExpoFailure(404).kind, 'terminal');
});

test('send posts the messages and returns one ticket per message, in order', async () => {
  let seen: { url: string; body: unknown } | null = null;
  const client = createExpoPushClient({
    timeoutMs: 1000,
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init.body)) };
      return json(200, { data: [{ status: 'ok', id: 'T1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] });
    }) as typeof fetch,
  });
  const tickets = await client.send([message('ExponentPushToken[a]'), message('ExponentPushToken[b]')]);
  assert.equal(seen!.url, 'https://exp.host/--/api/v2/push/send');
  assert.equal((seen!.body as unknown[]).length, 2);
  assert.deepEqual(tickets, [{ status: 'ok', id: 'T1' }, { status: 'error', message: 'gone', error: 'DeviceNotRegistered' }]);
});

test('an answer with the wrong number of tickets is retryable, never trusted', async () => {
  const client = createExpoPushClient({ timeoutMs: 1000, fetch: (async () => json(200, { data: [] })) as unknown as typeof fetch });
  await assert.rejects(() => client.send([message()]), (e: unknown) => e instanceof ExpoPushError && e.kind === 'retryable');
});

test('a network error and a timeout are retryable and never carry a token or a body', async () => {
  const boom = createExpoPushClient({ timeoutMs: 1000, fetch: (async () => { throw new Error('ECONNRESET ExponentPushToken[secret]'); }) as unknown as typeof fetch });
  await assert.rejects(
    () => boom.send([message()]),
    (e: unknown) => e instanceof ExpoPushError && e.kind === 'retryable' && e.reason === 'network_error' && !/secret/.test(e.message),
  );
  const slow = createExpoPushClient({ timeoutMs: 20, fetch: ((_u: string, init: RequestInit) => new Promise((_r, rej) => { init.signal!.addEventListener('abort', () => rej(init.signal!.reason)); })) as unknown as typeof fetch });
  await assert.rejects(() => slow.send([message()]), (e: unknown) => e instanceof ExpoPushError && e.reason === 'timeout');
});

test('more than 100 messages in one request is refused before any call', async () => {
  let calls = 0;
  const client = createExpoPushClient({ timeoutMs: 1000, fetch: (async () => { calls += 1; return json(200, { data: [] }); }) as unknown as typeof fetch });
  await assert.rejects(() => client.send(Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, () => message())), /at most 100/);
  assert.equal(calls, 0);
});

test('getReceipts maps ok and error receipts by ticket id', async () => {
  const client = createExpoPushClient({
    timeoutMs: 1000,
    fetch: (async () => json(200, { data: { T1: { status: 'ok' }, T2: { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } } } })) as unknown as typeof fetch,
  });
  assert.deepEqual(await client.getReceipts(['T1', 'T2', 'T3']), { T1: { status: 'ok' }, T2: { status: 'error', message: 'x', error: 'DeviceNotRegistered' } });
});
