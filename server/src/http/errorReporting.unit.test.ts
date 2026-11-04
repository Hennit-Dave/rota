import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import express, { Router } from 'express';
import { z } from 'zod';
import { jsonBody } from './json.js';
import { ApiError } from './errors.js';
import { createLogger, recordRouteBase } from './logger.js';
import { validateRequest } from './validate.js';
import { teamIdParams } from '../teams/schemas.js';
import { installPostRoutes, installPreRoutes } from './pipeline.js';
import type { ErrorContext, ErrorReporter } from '../observability/sentry.js';

// What the API's error handler tells Sentry (ADR 0039), checked with a reporter that only keeps what it was told. Which errors, and with what: the request ID, the
// user ID, the team ID and the route TEMPLATE, and nothing from the URL, the query string, the headers or the body.
const TEAM = '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b';
const USER = '11111111-1111-4111-8111-111111111111';
// Real team routes validate the path parameters (and reject a query they do not know); these accept any query so the test can prove it never travels with the event.
const anyQuery = z.looseObject({});

function start() {
  const reported: Array<{ error: unknown; context: ErrorContext | undefined }> = [];
  const reporter: ErrorReporter = {
    enabled: true,
    captureServerError: (error, context) => {
      reported.push({ error, context });
      return 'evt';
    },
    flush: async () => true,
    close: async () => true,
    stats: () => ({ send: 0, duplicate: 0, rate_limited: 0, cap_reached: 0, loadTest: 0 }),
  };
  const logger = createLogger(() => {});
  const app = express();
  installPreRoutes(app, logger);
  const teams = Router();
  teams.use(recordRouteBase); // every mounted router does this first (logger.ts): Express forgets the mount path once an error leaves a router
  teams.use((_req, res, next) => {
    res.locals.userId = USER; // what the auth middleware sets
    next();
  });
  teams.get('/:teamId/boom', validateRequest({ params: teamIdParams, query: anyQuery }), () => {
    throw new Error('database exploded for sam@example.com');
  });
  teams.get('/:teamId/not-found', validateRequest({ params: teamIdParams, query: anyQuery }), () => {
    throw new ApiError('not_found');
  });
  teams.get('/:teamId/down', validateRequest({ params: teamIdParams, query: anyQuery }), () => {
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  });
  teams.post('/:teamId/body', jsonBody(), (_req, res) => void res.json({ ok: true }));
  app.use('/teams', teams);
  app.get('/boom', () => {
    throw new Error('no user and no team here');
  });
  installPostRoutes(app, logger, reporter);
  const server = app.listen(0);
  after(() => void server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, reported };
}

describe('the error handler reports what is a bug, and only that', () => {
  it('an unexpected error is reported once, with the request ID, user, team and route template; the caller still gets the same plain 500', async () => {
    const { base, reported } = start();
    const res = await fetch(`${base}/teams/${TEAM}/boom?token=topsecret&email=sam@example.com`, { headers: { authorization: 'Bearer abcdefghijklmnop' } });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: { code: string; requestId: string; message: string } };
    assert.equal(body.error.code, 'internal_error');
    assert.equal(body.error.requestId, res.headers.get('x-request-id'));
    assert.ok(!body.error.message.includes('exploded'), 'the caller is told nothing about the error');

    assert.equal(reported.length, 1);
    const { error, context } = reported[0]!;
    assert.match((error as Error).message, /database exploded/);
    assert.deepEqual(context, {
      requestId: body.error.requestId,
      userId: USER,
      teamId: TEAM,
      route: '/teams/:teamId/boom',
      loadTestHeader: undefined,
    });
    // Nothing from the URL, the query string or the headers travels with it.
    const sent = JSON.stringify(context);
    for (const secret of ['topsecret', 'sam@example.com', 'abcdefghijklmnop', `${TEAM}/boom`]) assert.ok(!sent.includes(secret), secret);
  });

  it('a route with no team and no signed-in user is reported without them, never with a made-up value', async () => {
    const { base, reported } = start();
    await fetch(`${base}/boom`);
    assert.deepEqual(reported[0]!.context, { requestId: reported[0]!.context!.requestId, userId: undefined, teamId: undefined, route: '/boom', loadTestHeader: undefined });
  });

  it('a team ID in the path that is not a UUID is turned away by validation (a 400) before any handler runs, so there is nothing to report and no unvalidated value can become a tag', async () => {
    const { base, reported } = start();
    const res = await fetch(`${base}/teams/not-a-uuid/boom`);
    assert.equal(res.status, 400);
    assert.equal(reported.length, 0);
  });

  it('an expected rejection (an ApiError such as not_found) is NOT reported', async () => {
    const { base, reported } = start();
    const res = await fetch(`${base}/teams/${TEAM}/not-found`);
    assert.equal(res.status, 404);
    assert.equal(reported.length, 0);
  });

  it('a malformed JSON body is the caller\'s mistake, not ours: not reported', async () => {
    const { base, reported } = start();
    const res = await fetch(`${base}/teams/${TEAM}/body`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(res.status, 400);
    assert.equal(reported.length, 0);
  });

  it('a database that cannot be reached is answered with the polite 503 as before, AND reported (the gate keeps it to one per 5 minutes)', async () => {
    const { base, reported } = start();
    const res = await fetch(`${base}/teams/${TEAM}/down`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'service_unavailable');
    assert.equal(reported.length, 1);
    assert.deepEqual(reported[0]!.context!.tags, { reason: 'database_connection_failed' });
    assert.equal(reported[0]!.context!.teamId, TEAM);
  });

  it('the X-Load-Test header is only PASSED ALONG: whether it is honoured is the reporter\'s decision (LOAD_TEST_MODE), not the handler\'s', async () => {
    const { base, reported } = start();
    await fetch(`${base}/teams/${TEAM}/boom`, { headers: { 'x-load-test': 'k6' } });
    assert.equal(reported.length, 1, 'the handler reports it either way');
    assert.equal(reported[0]!.context!.loadTestHeader, 'k6');
  });

  it('with no reporter at all (every test, and a process with no DSN) the handler behaves exactly as before', async () => {
    const logger = createLogger(() => {});
    const app = express();
    installPreRoutes(app, logger);
    app.get('/boom', () => {
      throw new Error('x');
    });
    installPostRoutes(app, logger);
    const server = app.listen(0);
    after(() => void server.close());
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/boom`);
    assert.equal(res.status, 500);
  });
});
