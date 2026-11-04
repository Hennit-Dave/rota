import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import express from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Shards } from './clients.js';
import { createReadRouting, isConnectionError, readContext, type DbRoute, type ReadDb } from './readRouting.js';
import { shardFor } from './shard.js';

// Fake clients: each is just a label, so a test can see exactly which one a read was given. No database is touched.
const fake = (label: string) => ({ label }) as unknown as PrismaClient;
const labelOf = (db: ReadDb) => (db as unknown as { label: string }).label;

function makeShards(options: { replicas?: boolean; replicaFails?: boolean } = {}) {
  const replicas = options.replicas ?? true;
  let replicaCalls = 0;
  const build = (id: string) => ({
    primary: fake(`primary-${id}`),
    ...(replicas
      ? {
          reader: {
            $replica: () => {
              replicaCalls++;
              return fake(`replica-${id}`);
            },
          },
        }
      : {}),
  });
  const shards = { A: build('A'), B: build('B') } as unknown as Shards;
  return { shards, replicaCalls: () => replicaCalls };
}

// The fixed test vectors from data.md: this team is on shard A, that one on shard B.
const TEAM_A = '00000000-0000-4000-8000-000000000001';
const TEAM_B = '00000000-0000-4000-8000-000000000002';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function setup(opts: { replicas?: boolean; onReplicaError?: (e: unknown) => void } = {}) {
  let t = 1_000_000;
  const { shards, replicaCalls } = makeShards({ replicas: opts.replicas });
  const reads = createReadRouting({ shards, now: () => t, sweepMs: 5, onReplicaError: opts.onReplicaError });
  const routes: DbRoute[] = [];
  const read = (teamId: string, userId = USER, primaryRequired = false) =>
    reads.run(teamId, { userId, primaryRequired, onRoute: (r) => routes.push(r) }, async (db) => labelOf(db));
  return { reads, read, routes, replicaCalls, advance: (ms: number) => void (t += ms), stop: () => reads.stop() };
}

describe('the test vectors place the two teams on different shards', () => {
  it('A and B', () => {
    assert.equal(shardFor(TEAM_A), 'A');
    assert.equal(shardFor(TEAM_B), 'B');
  });
});

describe('read routing and read-your-own-writes (data.md tests 4 to 8 and 10)', () => {
  it('RESTART, then read at once: the primary, reason startup (test 5); after 5 s the replica, reason none', async () => {
    const s = setup();
    assert.equal(await s.read(TEAM_A), 'primary-A');
    assert.deepEqual(s.routes, ['startup']);
    s.advance(4_999);
    assert.equal(await s.read(TEAM_A), 'primary-A');
    s.advance(1);
    assert.equal(await s.read(TEAM_A), 'replica-A');
    assert.equal(s.routes.at(-1), 'none');
    s.stop();
  });

  it('WRITE, then read at 1 second: the primary, reason marker (test 4)', async () => {
    const s = setup();
    s.advance(60_000); // well past the startup window
    s.reads.markWrite(USER);
    s.advance(1_000);
    assert.equal(await s.read(TEAM_A), 'primary-A');
    assert.equal(s.routes.at(-1), 'marker');
    s.stop();
  });

  it('WRITE, then read at 6 seconds: the replica, reason none (test 6); at exactly 5 s the marker is gone', async () => {
    const s = setup();
    s.advance(60_000);
    s.reads.markWrite(USER);
    s.advance(4_999);
    assert.equal(await s.read(TEAM_A), 'primary-A');
    s.advance(1);
    assert.equal(await s.read(TEAM_A), 'replica-A');
    s.advance(1_000);
    assert.equal(await s.read(TEAM_A), 'replica-A');
    assert.equal(s.routes.at(-1), 'none');
    s.stop();
  });

  it("the marker is the writer's own: another user's read right after still goes to the replica", async () => {
    const s = setup();
    s.advance(60_000);
    s.reads.markWrite(USER);
    assert.equal(await s.read(TEAM_A, OTHER), 'replica-A');
    assert.equal(await s.read(TEAM_A, USER), 'primary-A');
    s.stop();
  });

  it('PRIMARY-REQUIRED reads go to the primary at any time, whatever the marker says (test 7)', async () => {
    const s = setup();
    s.advance(60_000);
    assert.equal(await s.read(TEAM_A, USER, true), 'primary-A');
    assert.equal(s.routes.at(-1), 'primary-required');
    s.reads.markWrite(USER);
    assert.equal(await s.read(TEAM_A, USER, true), 'primary-A');
    assert.equal(s.routes.at(-1), 'primary-required');
    s.stop();
  });

  it("each team's reads use ITS shard's clients", async () => {
    const s = setup();
    s.advance(60_000);
    assert.equal(await s.read(TEAM_A), 'replica-A');
    assert.equal(await s.read(TEAM_B), 'replica-B');
    s.reads.markWrite(USER);
    assert.equal(await s.read(TEAM_B), 'primary-B');
    s.stop();
  });

  it('a process with no replicas (a script) reads the primary and does not fail', async () => {
    const s = setup({ replicas: false });
    s.advance(60_000);
    assert.equal(await s.read(TEAM_A), 'primary-A');
    s.stop();
  });

  it('a replica that cannot be REACHED: the failure is reported, the primary answers, and the route says so', async () => {
    const errors: unknown[] = [];
    const s = setup({ onReplicaError: (e) => errors.push(e) });
    s.advance(60_000);
    const seen: string[] = [];
    const answer = await s.reads.run(TEAM_A, { userId: USER, onRoute: (r) => s.routes.push(r) }, async (db) => {
      seen.push(labelOf(db));
      if (labelOf(db).startsWith('replica')) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return 'answered by ' + labelOf(db);
    });
    assert.equal(answer, 'answered by primary-A');
    assert.deepEqual(seen, ['replica-A', 'primary-A']);
    assert.equal(errors.length, 1);
    assert.deepEqual(s.routes.slice(-2), ['none', 'replica-failed']);
    s.stop();
  });

  it('a QUERY error on the replica is NOT retried on the primary: it reaches the caller, nothing is reported, the primary is never asked', async () => {
    const errors: unknown[] = [];
    const s = setup({ onReplicaError: (e) => errors.push(e) });
    s.advance(60_000);
    const seen: string[] = [];
    const queryError = Object.assign(new Error(''), {
      code: 'P2010',
      meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '42P01', kind: 'TableDoesNotExist', table: 'nope' } } },
    });
    await assert.rejects(
      s.reads.run(TEAM_A, { userId: USER, onRoute: (r) => s.routes.push(r) }, async (db) => {
        seen.push(labelOf(db));
        throw queryError;
      }),
      (e) => e === queryError,
    );
    assert.deepEqual(seen, ['replica-A'], 'asked once, of the replica only');
    assert.deepEqual(errors, [], 'not a replica-reachability failure, so nothing reported');
    assert.deepEqual(s.routes, ['none'], 'never replica-failed');
    s.stop();
  });

  it('an error from the PRIMARY is not swallowed', async () => {
    const s = setup();
    s.advance(60_000);
    s.reads.markWrite(USER);
    await assert.rejects(
      s.reads.run(TEAM_A, { userId: USER }, async () => {
        throw new Error('primary down');
      }),
      /primary down/,
    );
    s.stop();
  });

  it('MAP CLEANUP: many users write once, and the map is empty again within seconds (test 10)', async () => {
    const s = setup();
    s.advance(60_000);
    for (let i = 0; i < 1_000; i++) s.reads.markWrite(`user-${i}`);
    assert.equal(s.reads.markedUsers(), 1_000);
    s.advance(5_000);
    await new Promise((r) => setTimeout(r, 40)); // the sweep runs every 5 ms here; it does no I/O
    assert.equal(s.reads.markedUsers(), 0);
    s.stop();
  });

  it('an expired marker is also removed when it is read', async () => {
    const s = setup();
    s.advance(60_000);
    s.reads.markWrite(USER);
    s.advance(5_001);
    assert.equal(s.reads.decide(USER), 'none');
    assert.equal(s.reads.markedUsers(), 0);
    s.stop();
  });

  it('readContext puts the route on res.locals.dbRoute for the request log', async () => {
    const s = setup();
    s.advance(60_000);
    const res = { locals: {} as Record<string, unknown> };
    const ctx = readContext(res as never, USER);
    await s.reads.run(TEAM_A, ctx, async () => 1);
    assert.equal(res.locals.dbRoute, 'none');
    s.reads.markWrite(USER);
    await s.reads.run(TEAM_A, ctx, async () => 1);
    assert.equal(res.locals.dbRoute, 'marker');
    s.stop();
  });
});

describe('the write marker middleware', () => {
  it('marks the signed-in user BEFORE the response reaches the client, for writes only', async () => {
    const s = setup();
    s.advance(60_000);
    const app = express();
    app.use(s.reads.writeMarker);
    // Stands in for the auth middleware, which sets the user on res.locals.
    app.use((req, res, next) => {
      const who = req.header('x-test-user');
      if (who) res.locals.userId = who;
      next();
    });
    app.post('/write', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 10)); // the "commit"
      res.json({ ok: true });
    });
    app.get('/read', (_req, res) => void res.json({ ok: true }));
    const server = app.listen(0);
    after(() => void server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A read marks nobody.
    await fetch(`${base}/read`, { headers: { 'x-test-user': USER } });
    assert.equal(s.reads.decide(USER), 'none');

    // A write with no signed-in user marks nobody.
    await fetch(`${base}/write`, { method: 'POST' });
    assert.equal(s.reads.markedUsers(), 0);

    // A write by a signed-in user: the moment the response is in the client's hands, the marker already exists.
    const res = await fetch(`${base}/write`, { method: 'POST', headers: { 'x-test-user': USER } });
    assert.equal(res.status, 200);
    assert.equal(s.reads.decide(USER), 'marker');
    assert.equal(s.reads.decide(OTHER), 'none');
    s.stop();
  });
});

describe('which errors mean "could not reach the replica"', () => {
  const adapterError = (cause: Record<string, unknown>) => Object.assign(new Error(''), { code: 'P2010', meta: { driverAdapterError: { name: 'DriverAdapterError', cause } } });

  it('connection and timeout errors, in the shapes Prisma 7 with adapter-pg really produces, are retried on the primary', () => {
    assert.equal(isConnectionError(adapterError({ kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 1 })), true, 'refused or unknown host');
    assert.equal(isConnectionError(adapterError({ kind: 'ConnectionClosed' })), true, 'reset by the server');
    assert.equal(isConnectionError(adapterError({ kind: 'SocketTimeout' })), true);
    assert.equal(isConnectionError(adapterError({ kind: 'TlsConnectionError' })), true);
    assert.equal(isConnectionError(adapterError({ kind: 'TooManyConnections' })), true);
    assert.equal(isConnectionError(new Error('Connection terminated due to connection timeout')), true, 'pg connect timeout');
    assert.equal(isConnectionError(new Error('timeout exceeded when trying to connect')), true, 'pg-pool wait');
    assert.equal(isConnectionError(new Error('Connection terminated unexpectedly')), true);
    assert.equal(isConnectionError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
    assert.equal(isConnectionError(Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) })), true, 'found down the cause chain');
  });

  it('errors the database RETURNED for the query are not: they reach the caller', () => {
    assert.equal(isConnectionError(adapterError({ kind: 'TableDoesNotExist', originalCode: '42P01', table: 't' })), false, 'missing table');
    assert.equal(isConnectionError(adapterError({ kind: 'postgres', code: '42601', message: 'syntax error at or near "selec"' })), false, 'syntax error');
    assert.equal(isConnectionError(adapterError({ kind: 'UniqueConstraintViolation' })), false);
    assert.equal(isConnectionError(adapterError({ kind: 'AuthenticationFailed' })), false, 'a wrong password is a configuration fault to surface, not to hide');
    assert.equal(isConnectionError(new Error('boom')), false);
    assert.equal(isConnectionError('not even an error'), false);
    assert.equal(isConnectionError(undefined), false);
  });
});
