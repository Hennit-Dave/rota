import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  NetworkError,
  NotSignedInError,
  OfflineError,
  RefreshUncertainError,
  RefreshUnavailableError,
  SessionEndedError,
  StaleAccountError,
  isRetryable,
  shouldRetryQuery,
} from './errors';
import { deferred, json, makeHarness, session, type Handler } from '../testkit';

const error = (code: string, requestId = 'req-1') => ({ error: { code, message: code, requestId } });

// A server that accepts only the new token and hands it out on refresh.
const rotating: Handler = async (call) => {
  if (call.path === '/auth/refresh') {
    await new Promise((r) => setTimeout(r, 5));
    return json(200, session('new', 'r2'));
  }
  return call.authorization === 'Bearer new' ? json(200, { ok: true }) : json(401, error('unauthenticated'));
};

test('attaches the bearer token, and none when auth is false', async () => {
  const h = makeHarness({ handler: () => json(200, { ok: true }) });
  await h.client.get('/shifts');
  await h.client.get('/health', { auth: false });
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
  assert.equal(h.calls[1]?.authorization, null);
});

test('app-state test 10: several simultaneous 401s trigger exactly one refresh', async () => {
  const h = makeHarness({ handler: rotating });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => h.client.get<{ ok: boolean }>('/data')));
  assert.equal(h.refreshCalls(), 1);
  assert.deepEqual(results, Array(5).fill({ ok: true }));
  assert.deepEqual(h.tokens.current(), { accessToken: 'new', refreshToken: 'r2' });
  assert.equal(h.tokens.writes.length, 1);
});

test('a late 401 from before the refresh retries with the new token instead of refreshing again', async () => {
  const release = deferred();
  const handler: Handler = async (call) => {
    if (call.path === '/slow' && call.authorization === 'Bearer old') {
      await release.promise;
      return json(401, error('unauthenticated'));
    }
    return rotating(call, {});
  };
  const h = makeHarness({ handler });
  const slow = h.client.get('/slow');
  await new Promise((r) => setTimeout(r, 1));
  await h.client.get('/data'); // 401, one refresh, success
  release.resolve();
  await slow;
  assert.equal(h.refreshCalls(), 1);
});

test('ADR 0005: a 401 from /auth/refresh signs out, once, for every waiting request', async () => {
  const h = makeHarness({
    handler: (call) => (call.path === '/auth/refresh' ? json(401, error('unauthenticated')) : json(401, error('unauthenticated'))),
  });
  const outcomes = await Promise.allSettled([h.client.get('/a'), h.client.get('/b'), h.client.get('/c')]);
  for (const o of outcomes) {
    assert.equal(o.status, 'rejected');
    assert.ok((o as PromiseRejectedResult).reason instanceof SessionEndedError);
  }
  assert.deepEqual(h.invalidated, ['refresh_rejected']);
  assert.equal(h.refreshCalls(), 1);
});

test('ADR 0005: a 400 from /auth/refresh also signs out, and is logged as an app bug without the token', async () => {
  const h = makeHarness({
    handler: (call) => (call.path === '/auth/refresh' ? json(400, error('validation_failed', 'req-9')) : json(401, error('unauthenticated'))),
  });
  await assert.rejects(h.client.get('/a'), SessionEndedError);
  assert.deepEqual(h.invalidated, ['refresh_malformed']);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0]?.event, 'refresh_malformed_token');
  assert.equal(h.warnings[0]?.fields.requestId, 'req-9');
  assert.ok(!JSON.stringify(h.warnings).includes('r1'), 'the refresh token must never reach the log');
});

test('app-state test 11: 429 and 503 keep the session and are safe to retry', async () => {
  for (const status of [429, 503]) {
    const h = makeHarness({
      handler: (call) =>
        call.path === '/auth/refresh' ? json(status, error('service_unavailable'), { 'Retry-After': '7' }) : json(401, error('unauthenticated')),
    });
    const failure = await h.client.get('/a').then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(failure instanceof RefreshUnavailableError);
    assert.equal(failure.status, status);
    assert.equal(failure.retryAfterSeconds, 7);
    assert.ok(isRetryable(failure));
    assert.deepEqual(h.invalidated, []);
    assert.deepEqual(h.tokens.current(), { accessToken: 'old', refreshToken: 'r1' });
  }
});

test('app-state test 11: offline before the request is sent keeps the session and sends nothing', async () => {
  const h = makeHarness({ handler: () => json(200, {}), online: () => false });
  await assert.rejects(h.client.get('/a'), OfflineError);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.invalidated, []);
});

test('offline at refresh time: no refresh is sent, the session is kept', async () => {
  let online = true;
  const h = makeHarness({
    handler: () => {
      online = false; // the connection drops right after the first request goes out
      return json(401, error('unauthenticated'));
    },
    online: () => online,
  });
  await assert.rejects(h.client.get('/a'), OfflineError);
  assert.equal(h.refreshCalls(), 0);
  assert.deepEqual(h.invalidated, []);
});

test('app-state test 11: a lost refresh response is not replayed and does not sign out', async () => {
  const h = makeHarness({
    handler: (call) => {
      if (call.path === '/auth/refresh') throw new TypeError('network request failed');
      return json(401, error('unauthenticated'));
    },
  });
  const failure = await h.client.get('/a').then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(failure instanceof RefreshUncertainError);
  assert.equal(h.refreshCalls(), 1, 'sent once, never replayed');
  assert.deepEqual(h.invalidated, [], 'the session is kept; the next attempt is expected to fail as reuse');
  assert.equal(isRetryable(failure), false);
  assert.equal(shouldRetryQuery(0, failure), false, 'TanStack must not retry it');
});

test('a refresh that times out is uncertain too', async () => {
  const h = makeHarness({
    timeoutMs: 20,
    handler: (call, init) =>
      call.path === '/auth/refresh'
        ? new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        : json(401, error('unauthenticated')),
  });
  await assert.rejects(h.client.get('/a'), RefreshUncertainError);
  assert.deepEqual(h.invalidated, []);
});

test('app-state test 9: a response that arrives after the account changed is discarded', async () => {
  const gate = deferred();
  const h = makeHarness({
    handler: async () => {
      await gate.promise;
      return json(200, { shifts: ['account A'] });
    },
  });
  const pending = h.client.get('/shifts');
  await new Promise((r) => setTimeout(r, 1));
  h.epoch.bump(); // sign-out
  gate.resolve();
  await assert.rejects(pending, StaleAccountError);
});

test('app-state test 9: a refresh that finishes after sign-out never writes the old account its new tokens', async () => {
  const gate = deferred();
  const h = makeHarness({
    handler: async (call) => {
      if (call.path === '/auth/refresh') {
        await gate.promise;
        return json(200, session('new', 'r2'));
      }
      return json(401, error('unauthenticated'));
    },
  });
  const pending = h.client.get('/a');
  await new Promise((r) => setTimeout(r, 1));
  h.epoch.bump();
  gate.resolve();
  await assert.rejects(pending, StaleAccountError);
  assert.equal(h.tokens.writes.length, 0);
});

test('a refresh refused after sign-out does not sign the next account out', async () => {
  const gate = deferred();
  const h = makeHarness({
    handler: async (call) => {
      if (call.path === '/auth/refresh') {
        await gate.promise;
        return json(401, error('unauthenticated'));
      }
      return json(401, error('unauthenticated'));
    },
  });
  const pending = h.client.get('/a');
  await new Promise((r) => setTimeout(r, 1));
  h.epoch.bump();
  gate.resolve();
  await assert.rejects(pending, StaleAccountError);
  assert.deepEqual(h.invalidated, []);
});

test('if the new tokens cannot be saved the session cannot continue: sign out', async () => {
  const h = makeHarness({ handler: rotating });
  h.tokens.failWrites = true;
  await assert.rejects(h.client.get('/a'), SessionEndedError);
  assert.deepEqual(h.invalidated, ['token_write_failed']);
});

test('an unreadable refresh answer is uncertain, not a sign-out', async () => {
  const h = makeHarness({
    handler: (call) => (call.path === '/auth/refresh' ? new Response('not json', { status: 200 }) : json(401, error('unauthenticated'))),
  });
  await assert.rejects(h.client.get('/a'), RefreshUncertainError);
  assert.deepEqual(h.invalidated, []);
});

test('a second 401 right after a successful refresh is returned as an error, with no loop and no sign-out', async () => {
  const h = makeHarness({
    handler: (call) => (call.path === '/auth/refresh' ? json(200, session('new', 'r2')) : json(401, error('unauthenticated'))),
  });
  await assert.rejects(h.client.get('/a'), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(h.refreshCalls(), 1);
  assert.deepEqual(h.invalidated, []);
});

test('no tokens on the device is NotSignedIn, not a request', async () => {
  const h = makeHarness({ handler: () => json(200, {}), tokens: null });
  await assert.rejects(h.client.get('/a'), NotSignedInError);
  assert.equal(h.calls.length, 0);
});

test('server errors become ApiError with code and request ID; 204 is undefined; junk 200 is invalid_response', async () => {
  const h = makeHarness({
    handler: (call) => {
      if (call.path === '/missing') return json(404, error('not_found', 'body-id'), { 'X-Request-Id': 'header-id' });
      if (call.path === '/empty') return new Response(null, { status: 204 });
      return new Response('<html>', { status: 200 });
    },
  });
  const notFound = await h.client.get('/missing').then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(notFound instanceof ApiError);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.code, 'not_found');
  assert.equal(notFound.requestId, 'header-id');
  assert.equal(await h.client.post('/empty'), undefined);
  await assert.rejects(h.client.get('/junk'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
});

test('retry policy: 5xx and network failures retry, 4xx and everything uncertain do not', () => {
  assert.equal(isRetryable(new ApiError(503, 'x', 'x', null)), true);
  assert.equal(isRetryable(new ApiError(400, 'x', 'x', null)), false);
  assert.equal(isRetryable(new ApiError(401, 'x', 'x', null)), false);
  assert.equal(isRetryable(new NetworkError('x', false)), true);
  assert.equal(isRetryable(new OfflineError()), false);
  assert.equal(isRetryable(new StaleAccountError()), false);
  assert.equal(isRetryable(new SessionEndedError('refresh_rejected')), false);
  assert.equal(shouldRetryQuery(2, new NetworkError('x', false)), false, 'at most two retries');
});

test('a timeout is a NetworkError; a cancelled request rethrows the cancellation', async () => {
  const hang: Handler = (_call, init) =>
    new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const timed = makeHarness({ handler: hang, timeoutMs: 20 });
  await assert.rejects(timed.client.get('/a', { auth: false }), (e: unknown) => e instanceof NetworkError && e.timedOut);

  const cancelled = makeHarness({ handler: hang });
  const controller = new AbortController();
  const pending = cancelled.client.get('/a', { auth: false, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
});
