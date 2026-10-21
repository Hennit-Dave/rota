import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import { createLogger } from '../http/logger.js';
import { installPostRoutes, installPreRoutes } from '../http/pipeline.js';
import { createRequireAuth } from './middleware.js';
import { loadAuthConfig } from './config.js';
import { createTokenService } from './tokens.js';

const lines: string[] = [];
const logger = createLogger((l) => lines.push(l));
const tokens = createTokenService({ secret: new Uint8Array(32).fill(5), config: loadAuthConfig({}) });
const userId = randomUUID();
const familyId = randomUUID();

let activeFamilies = new Set<string>();
let dbCalls = 0;
const db = {
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    dbCalls++;
    // values are [familyId, userId] in the order the query binds them
    return values[0] === familyId && values[1] === userId && activeFamilies.has(String(values[0])) ? [{ ok: 1 }] : [];
  },
};

let base: string;
let close: () => Promise<void>;
before(async () => {
  const app = express();
  installPreRoutes(app, logger);
  app.get('/private', createRequireAuth({ tokens, db: db as never }), (req, res) => void res.json(req.auth));
  installPostRoutes(app, logger);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
});
after(() => close());

const get = (headers: Record<string, string> = {}) => fetch(`${base}/private`, { headers });
const reasons = () => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request_rejected').map((l) => l.reason);

test('no header, wrong scheme, and malformed headers are all the same public 401 with a Bearer challenge', async () => {
  lines.length = 0;
  for (const headers of [{} as Record<string, string>, { authorization: 'Basic dXNlcjpwYXNz' }, { authorization: 'Bearer' }, { authorization: 'Bearer not-a-jwt' }, { authorization: 'Bearer  a.b.c' }]) {
    const res = await get(headers);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'unauthenticated');
  }
  assert.deepEqual(reasons().slice(0, 2), ['missing_token', 'malformed_authorization_header']);
});

test('a valid token with a live session passes, and identity comes from the token and session', async () => {
  activeFamilies = new Set([familyId]);
  const { token } = await tokens.sign({ userId, familyId });
  const res = await get({ authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { userId, familyId });
  const accepted = await get({ authorization: `bearer ${token}` });
  assert.equal(accepted.status, 200, 'the scheme name is case-insensitive (RFC 7235)');
});

test('a valid token whose session is gone or revoked is refused, and the check ran against the database', async () => {
  activeFamilies = new Set();
  const { token } = await tokens.sign({ userId, familyId });
  lines.length = 0;
  const before = dbCalls;
  const res = await get({ authorization: `Bearer ${token}` });
  assert.equal(res.status, 401);
  assert.equal(dbCalls, before + 1, 'exactly one session lookup per authenticated request');
  assert.ok(reasons().includes('session_inactive'));
});

test('the session must belong to the token\'s user: another user\'s family is refused', async () => {
  activeFamilies = new Set([familyId]);
  const { token } = await tokens.sign({ userId: randomUUID(), familyId });
  assert.equal((await get({ authorization: `Bearer ${token}` })).status, 401);
});

test('a bad token never reaches the database', async () => {
  const before = dbCalls;
  await get({ authorization: 'Bearer aaa.bbb.ccc' });
  assert.equal(dbCalls, before);
});

test('the log never contains the token', async () => {
  activeFamilies = new Set([familyId]);
  const { token } = await tokens.sign({ userId, familyId });
  lines.length = 0;
  await get({ authorization: `Bearer ${token}` });
  await get({ authorization: `Bearer ${token.slice(0, -3)}abc` });
  const raw = lines.join('\n');
  assert.ok(!raw.includes(token) && !raw.includes(token.split('.')[1]!));
});
