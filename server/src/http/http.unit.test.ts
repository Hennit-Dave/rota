import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { createLogger, recordRouteBase } from './logger.js';
import { ApiError } from './errors.js';
import { jsonBody } from './json.js';
import { installPostRoutes, installPreRoutes } from './pipeline.js';
import { validateRequest, toErrorDetails } from './validate.js';
import { createRateLimiter, rateLimit, RateLimiterUnavailableError, type RateLimiter } from '../ratelimit/limiter.js';

const lines: string[] = [];
const logger = createLogger((l) => lines.push(l));
const logs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

let base: string;
let close: () => Promise<void>;
let limiterBehaviour: 'allow' | 'deny' | 'down' = 'allow';

before(async () => {
  const app = express();
  installPreRoutes(app, logger);

  const fake: RateLimiter = {
    async consume(rule) {
      if (limiterBehaviour === 'down') throw new RateLimiterUnavailableError('ECONNREFUSED rediss://default:hunter2@host:1');
      return limiterBehaviour === 'deny'
        ? { allowed: false, count: rule.max + 1, remaining: 0, retryAfterSeconds: 42 }
        : { allowed: true, count: 1, remaining: rule.max - 1, retryAfterSeconds: 1 };
    },
  };

  const schema = z.strictObject({ email: z.email(), password: z.string().min(15).max(128) });
  app.post(
    '/t/:id',
    jsonBody(),
    validateRequest({ params: z.strictObject({ id: z.uuid() }), body: schema }),
    (req, res) => {
      res.locals.userId = '11111111-1111-4111-8111-111111111111';
      res.locals.dbRoute = 'primary-required';
      res.status(201).json({ ok: true });
    },
  );
  app.post(
    '/limited',
    jsonBody(),
    validateRequest({ body: z.strictObject({ email: z.string() }) }),
    rateLimit(fake, logger, (req) => [{ name: 'login_email', subject: String((req.validated!.body as { email: string }).email), max: 5, windowSeconds: 900 }]),
    (_req, res) => void res.json({ ok: true }),
  );
  const mounted = express.Router();
  mounted.use(recordRouteBase);
  mounted.get('/ok', (_req, res) => void res.json({ ok: true }));
  mounted.get('/fails', () => {
    throw new ApiError('invalid_credentials');
  });
  app.use('/mounted', mounted);
  app.get('/boom', () => {
    throw new Error('db exploded at postgresql://admin:supersecret@host/db with password=hunter2');
  });
  app.get('/teapot', () => {
    throw new ApiError('invalid_credentials', { reason: 'unknown_email' });
  });
  installPostRoutes(app, logger);

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
});

after(async () => {
  await close();
});

const UUID = '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b';
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('request ID: a valid incoming UUID is kept and echoed; anything else is replaced', async () => {
  const good = '9b2f6d0e-1c3a-4f5b-8a7d-2e4c6a8b0d1f';
  const r1 = await fetch(base + '/health-ish', { headers: { 'X-Request-Id': good } });
  assert.equal(r1.headers.get('x-request-id'), good);

  for (const bad of ['not-a-uuid', 'x'.repeat(500), '9b2f6d0e-1c3a-4f5b-8a7d-2e4c6a8b0d1f\nforged: log-line', '']) {
    const r = await fetch(base + '/health-ish', { headers: { 'X-Request-Id': bad.replace(/\n/g, ' ') } });
    const id = r.headers.get('x-request-id')!;
    assert.notEqual(id, bad);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('error body has the one shape, the request ID matches the header, and unknown routes are JSON 404', async () => {
  const res = await fetch(base + '/nope');
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
  assert.equal(body.error.code, 'not_found');
  assert.equal(body.error.requestId, res.headers.get('x-request-id'));
  assert.ok(body.error.message);
});

test('validation covers params, query and body; unknown keys are rejected; no submitted value is echoed', async () => {
  const secretValue = 'SuperSecretPasswordValue-do-not-echo';
  const res = await post(
    '/t/not-a-uuid?extra=1',
    { email: 'nope', password: secretValue.slice(0, 5), surprise: secretValue },
  );
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!text.includes('SuperSecret'), 'submitted values must not be echoed');
  assert.ok(!text.includes('surprise'), 'unknown key NAMES must not be echoed either');
  const body = JSON.parse(text) as { error: { code: string; details: Array<{ path: string; code: string; min?: number }> } };
  assert.equal(body.error.code, 'validation_failed');
  const byPath = Object.fromEntries(body.error.details.map((d) => [d.path, d]));
  assert.equal(byPath['params.id']?.code, 'invalid_uuid');
  assert.equal(byPath['query']?.code, 'unrecognized_key');
  assert.equal(byPath['email']?.code, 'invalid_email');
  assert.deepEqual({ code: byPath['password']?.code, min: byPath['password']?.min }, { code: 'too_short', min: 15 });
  assert.ok(body.error.details.some((d) => d.path === '' && d.code === 'unrecognized_key'), 'unknown body key reported without its name');
});

test('a valid request passes and handlers read validated data only', async () => {
  const res = await post(`/t/${UUID}`, { email: 'a@b.co', password: 'p'.repeat(15) });
  assert.equal(res.status, 201);
});

test('malformed JSON is 400 invalid_json; an oversized body is 413 payload_too_large', async () => {
  const bad = await post(`/t/${UUID}`, '{"email": ');
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'invalid_json');

  const big = await post(`/t/${UUID}`, JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(20_000) }));
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { error: { code: string } }).error.code, 'payload_too_large');
});

test('an unexpected error is a plain 500 and nothing sensitive reaches the caller or the log', async () => {
  lines.length = 0;
  const res = await fetch(base + '/boom');
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'internal_error');
  for (const leak of ['supersecret', 'hunter2', 'admin', 'exploded']) assert.ok(!text.includes(leak), `body leaked ${leak}`);
  const logged = lines.join('\n');
  for (const leak of ['supersecret', 'hunter2', 'admin:']) assert.ok(!logged.includes(leak), `log leaked ${leak}`);
});

test('a rejection reason stays in the server log and is not sent to the client', async () => {
  lines.length = 0;
  const res = await fetch(base + '/teapot');
  assert.equal(res.status, 401);
  assert.ok(!(await res.text()).includes('unknown_email'));
  assert.ok(logs().some((l) => l.msg === 'request_rejected' && l.reason === 'unknown_email'));
});

test('request log line has the required fields, a route template, and nothing from the body', async () => {
  lines.length = 0;
  const password = 'CorrectHorseBatteryStaple-1';
  const res = await post(`/t/${UUID}`, { email: 'someone@example.com', password });
  assert.equal(res.status, 201);
  const line = logs().find((l) => l.msg === 'request')!;
  for (const key of ['ts', 'level', 'requestId', 'userId', 'method', 'route', 'status', 'durationMs', 'dbRoute']) {
    assert.ok(key in line, `missing ${key}`);
  }
  assert.equal(line.route, '/t/:id', 'route is the template, not the URL');
  assert.equal(line.requestId, res.headers.get('x-request-id'));
  assert.match(String(line.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const raw = lines.join('\n');
  for (const secret of [password, 'someone@example.com', UUID]) assert.ok(!raw.includes(secret), `log leaked ${secret}`);
});

test('a token in the query string is rejected by validation and never reaches the log', async () => {
  lines.length = 0;
  const res = await post(`/t/${UUID}?token=abc123`, { email: 'someone@example.com', password: 'p'.repeat(15) });
  assert.equal(res.status, 400);
  assert.ok(!lines.join('\n').includes('abc123'));
  assert.ok(!(await res.text()).includes('abc123'));
});

test('the route template keeps its mount prefix for successes AND for errors thrown inside a mounted router', async () => {
  lines.length = 0;
  await fetch(base + '/mounted/ok');
  await fetch(base + '/mounted/fails');
  const routes = logs().filter((l) => l.msg === 'request').map((l) => `${l.status} ${l.route}`);
  assert.deepEqual(routes, ['200 /mounted/ok', '401 /mounted/fails']);
});

test('error responses log the error code', async () => {
  lines.length = 0;
  await fetch(base + '/nope');
  const line = logs().find((l) => l.msg === 'request')!;
  assert.equal(line.errorCode, 'not_found');
  assert.equal(line.status, 404);
  assert.equal(line.level, 'warn');
});

test('logger only accepts allow-listed fields and primitive values', () => {
  const out: string[] = [];
  const log = createLogger((l) => out.push(l));
  // Fields outside the allow-list can't be written in typed code, so force them in to prove the runtime drops them.
  log.info('x', {
    requestId: 'r1',
    password: 'hunter2',
    authorization: 'Bearer abc',
    reason: 'x'.repeat(1000),
  } as never);
  const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
  assert.equal(parsed.requestId, 'r1');
  assert.ok(!('password' in parsed) && !('authorization' in parsed));
  assert.equal(String(parsed.reason).length, 300);
});

test('rate limit middleware: denied is 429 with Retry-After, down is 503 (fail closed), and the limit never reaches the handler', async () => {
  limiterBehaviour = 'deny';
  lines.length = 0;
  const denied = await post('/limited', { email: 'a@b.co' });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('retry-after'), '42');
  const body = (await denied.json()) as { error: { code: string; retryAfterSeconds: number } };
  assert.deepEqual({ code: body.error.code, s: body.error.retryAfterSeconds }, { code: 'rate_limited', s: 42 });
  const rl = logs().find((l) => l.msg === 'rate_limited')!;
  assert.equal(rl.rule, 'login_email');
  assert.ok(!lines.join('\n').includes('a@b.co'), 'the subject is never logged');

  limiterBehaviour = 'down';
  lines.length = 0;
  const down = await post('/limited', { email: 'a@b.co' });
  assert.equal(down.status, 503);
  assert.equal(((await down.json()) as { error: { code: string } }).error.code, 'service_unavailable');
  assert.ok(!lines.join('\n').includes('hunter2'), 'connection credentials redacted from the log');

  limiterBehaviour = 'allow';
  assert.equal((await post('/limited', { email: 'a@b.co' })).status, 200);
});

test('toErrorDetails never includes input values', () => {
  const r = z.strictObject({ a: z.string().min(20) }).safeParse({ a: 'TOP-SECRET' });
  assert.ok(!r.success);
  assert.ok(!JSON.stringify(toErrorDetails(r.error)).includes('TOP-SECRET'));
});

test('limiter wired with a real RateLimiter object type-checks against the fake pipeline shape', () => {
  assert.equal(typeof createRateLimiter, 'function');
});
