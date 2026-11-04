import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import * as Sentry from '@sentry/node';
import { createErrorReporter, loadSentryConfig, type ErrorReporter, type SentryConfig } from './sentry.js';

// The reporter with a transport that KEEPS the envelopes instead of sending them: nothing here reaches Sentry. What is checked is exactly what would have been sent.
const DSN = 'https://publickeyfortests@o1.ingest.de.sentry.io/1';
const TEAM_A = '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b';
const TEAM_B = '00000000-0000-4000-8000-000000000002';
const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = `sk_test_${randomBytes(18).toString('base64url')}`;

type Envelope = [Record<string, unknown>, Array<[{ type?: string }, any]>];
function capture() {
  const envelopes: Envelope[] = [];
  const transport = () => ({
    send: async (envelope: Envelope) => {
      envelopes.push(envelope);
      return {};
    },
    flush: async () => true,
  });
  /** Every error event that was sent, as the object Sentry would receive. */
  const events = () => envelopes.flatMap((e) => e[1].filter(([h]) => h.type === 'event').map(([, payload]) => payload));
  /** Every item of any other type (a log, a metric, a transaction...): there must be none. */
  const otherItems = () => envelopes.flatMap((e) => e[1].filter(([h]) => h.type !== 'event' && h.type !== 'client_report').map(([h]) => h.type));
  return { transport: transport as any, envelopes, events, otherItems };
}

const baseConfig = (over: Partial<SentryConfig> = {}): SentryConfig => ({
  dsn: DSN,
  environment: 'test',
  loadTestMode: false,
  maxPerDay: 50,
  maxPerMinute: 10,
  dedupeSeconds: 300,
  ...over,
});

const reporters: ErrorReporter[] = [];
function setup(over: Partial<SentryConfig> = {}, role: 'api' | 'worker' = 'api') {
  const c = capture();
  const reporter = createErrorReporter(baseConfig(over), { role, transport: c.transport });
  reporters.push(reporter);
  return { reporter, ...c };
}
after(async () => {
  for (const r of reporters) await r.close(500);
});

describe('config', () => {
  it('defaults: off without a DSN, environment development, the load-test switch OFF, the limits Dave approved (50 a day, 10 a minute, 1 per error per 5 minutes)', () => {
    assert.deepEqual(loadSentryConfig({}), { dsn: undefined, environment: 'development', loadTestMode: false, maxPerDay: 50, maxPerMinute: 10, dedupeSeconds: 300 });
    assert.equal(loadSentryConfig({ SENTRY_DSN: '' }).dsn, undefined);
  });

  it('reads the values, and refuses a bad one without showing it', () => {
    const c = loadSentryConfig({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'deployed', LOAD_TEST_MODE: 'true', SENTRY_MAX_EVENTS_PER_DAY: '20' });
    assert.deepEqual([c.dsn, c.environment, c.loadTestMode, c.maxPerDay], [DSN, 'deployed', true, 20]);
    assert.throws(() => loadSentryConfig({ SENTRY_DSN: 'not-a-dsn-secret-value' }), (e: Error) => /not a valid Sentry DSN/.test(e.message) && !e.message.includes('secret-value'));
    assert.throws(() => loadSentryConfig({ LOAD_TEST_MODE: 'yes' }), /LOAD_TEST_MODE must be "true" or "false"/);
    assert.throws(() => loadSentryConfig({ SENTRY_MAX_EVENTS_PER_DAY: '0' }), /SENTRY_MAX_EVENTS_PER_DAY/);
  });
});

describe('without a DSN, Sentry is off and nothing can be sent', () => {
  it('a disabled reporter does nothing and never throws', async () => {
    const r = createErrorReporter(baseConfig({ dsn: undefined }), { role: 'api' });
    assert.equal(r.enabled, false);
    assert.equal(r.captureServerError(new Error('x'), { requestId: 'r' }), undefined);
    assert.equal(await r.flush(), true);
  });
});

describe('what an event carries (observability.md test 6: request, user and team tags, and no secrets)', () => {
  it('request ID, team ID, user ID, route and role are on it, and none of the secrets in the error or the extra data are', async () => {
    const s = setup();
    const id = s.reporter.captureServerError(new Error(`could not charge for sam@example.com using ${SECRET} and card 4242 4242 4242 4242`), {
      requestId: 'req-1',
      userId: USER,
      teamId: TEAM_A,
      route: '/teams/:teamId/billing/changes',
      extra: { email: 'sam@example.com', authorization: 'Bearer abcdefghijklmnop', attempt: 3 },
    });
    assert.ok(id, 'an event id came back');
    await s.reporter.flush(1000);
    const [event] = s.events();
    assert.deepEqual(event.tags, { role: 'api', request_id: 'req-1', team_id: TEAM_A, route: '/teams/:teamId/billing/changes' });
    assert.deepEqual(event.user, { id: USER });
    assert.equal(event.environment, 'test');
    assert.equal(event.server_name, 'rota-api');
    const text = JSON.stringify(s.envelopes);
    for (const secret of [SECRET, 'sam@example.com', '4242 4242 4242 4242', 'abcdefghijklmnop']) assert.ok(!text.includes(secret), `${secret.slice(0, 10)}... was sent`);
    assert.equal(event.extra.attempt, 3, 'useful extra data stays');
    assert.equal(event.request, undefined, 'no request is attached');
  });

  it('only errors are sent: no log, no metric, no transaction, no breadcrumb', async () => {
    const s = setup();
    Sentry.logger.info('a log line that must not leave');
    Sentry.addBreadcrumb({ category: 'console', message: 'a breadcrumb that must not leave' });
    s.reporter.captureServerError(new Error('one error'), { requestId: 'r' });
    await s.reporter.flush(1000);
    assert.equal(s.events().length, 1);
    assert.deepEqual(s.otherItems(), [], 'nothing but the error was sent');
    assert.ok(!JSON.stringify(s.envelopes).includes('must not leave'));
    assert.equal(s.events()[0].breadcrumbs, undefined);
  });

  it('a worker job carries its kind, row and the request that made it', async () => {
    const s = setup({}, 'worker');
    s.reporter.captureServerError(new Error('job failed'), { requestId: 'origin-req', tags: { job_kind: 'email', row_id: 'row-1', attempts: '5', terminal: 'false' } });
    await s.reporter.flush(1000);
    assert.deepEqual(s.events()[0].tags, { role: 'worker', request_id: 'origin-req', job_kind: 'email', row_id: 'row-1', attempts: '5', terminal: 'false' });
    assert.equal(s.events()[0].server_name, 'rota-worker');
  });
});

describe('two requests failing at the same time never swap their tags', () => {
  it('each event carries its own request ID, team ID and user ID', async () => {
    const s = setup();
    // Fired together, the way two requests would be: if tags lived on a shared scope, one would overwrite the other.
    await Promise.all(
      [
        { id: 'req-A', team: TEAM_A, user: USER, message: 'failure in A' },
        { id: 'req-B', team: TEAM_B, user: '22222222-2222-4222-8222-222222222222', message: 'different failure in B' },
      ].map(async (r) => {
        await new Promise((resolve) => setImmediate(resolve));
        s.reporter.captureServerError(new Error(r.message), { requestId: r.id, teamId: r.team, userId: r.user, route: '/x' });
      }),
    );
    await s.reporter.flush(1000);
    const byMessage = new Map(s.events().map((e) => [e.exception.values[0].value as string, e]));
    assert.equal(byMessage.get('failure in A').tags.request_id, 'req-A');
    assert.equal(byMessage.get('failure in A').tags.team_id, TEAM_A);
    assert.equal(byMessage.get('failure in A').user.id, USER);
    assert.equal(byMessage.get('different failure in B').tags.request_id, 'req-B');
    assert.equal(byMessage.get('different failure in B').tags.team_id, TEAM_B);
    assert.equal(byMessage.get('different failure in B').user.id, '22222222-2222-4222-8222-222222222222');
  });
});

describe('the gate: what may leave (1 per error per 5 minutes, 10 a minute, 50 a day: chosen, not measured)', () => {
  it('the same error twice sends one event; the second is counted as a duplicate', async () => {
    const s = setup();
    const boom = () => new Error('relation shifts does not exist');
    s.reporter.captureServerError(boom(), { requestId: 'a' });
    s.reporter.captureServerError(boom(), { requestId: 'b' });
    await s.reporter.flush(1000);
    assert.equal(s.events().length, 1);
    assert.equal(s.reporter.stats().duplicate, 1);
  });

  it('ten different errors in a minute go, the eleventh and twelfth do not', async () => {
    const s = setup();
    for (let i = 0; i < 12; i++) s.reporter.captureServerError(new Error(`distinct failure number ${'x'.repeat(i + 1)}`), { requestId: `r${i}` });
    await s.reporter.flush(1000);
    assert.equal(s.events().length, 10);
    assert.equal(s.reporter.stats().rate_limited, 2);
  });

  it('the daily cap is a config value: with 3 a day, the fourth different error is dropped', async () => {
    const s = setup({ maxPerDay: 3 });
    for (let i = 0; i < 5; i++) s.reporter.captureServerError(new Error(`cap test ${'y'.repeat(i + 1)}`), {});
    await s.reporter.flush(1000);
    assert.equal(s.events().length, 3);
    assert.equal(s.reporter.stats().cap_reached, 2);
  });
});

describe('X-Load-Test (the k6 run): honoured ONLY while LOAD_TEST_MODE is on', () => {
  it('switch OFF (the default): the header is IGNORED, so a client cannot hide its errors by sending it', async () => {
    const s = setup({ loadTestMode: false });
    s.reporter.captureServerError(new Error('from a client that sent the header'), { requestId: 'r', loadTestHeader: 'k6' });
    await s.reporter.flush(1000);
    assert.equal(s.events().length, 1, 'the event was sent');
    assert.equal(s.reporter.stats().loadTest, 0);
  });

  it('switch ON: an error from a request that carries the header is not sent, and is counted', async () => {
    const s = setup({ loadTestMode: true });
    s.reporter.captureServerError(new Error('from k6'), { requestId: 'r', loadTestHeader: 'k6' });
    s.reporter.captureServerError(new Error('from k6 with other casing'), { requestId: 'r', loadTestHeader: ' K6 ' });
    await s.reporter.flush(1000);
    assert.equal(s.events().length, 0);
    assert.equal(s.reporter.stats().loadTest, 2);
  });

  it('switch ON: errors without the header, or with another value, are still sent', async () => {
    const s = setup({ loadTestMode: true });
    s.reporter.captureServerError(new Error('a real user error'), { requestId: 'r1' });
    s.reporter.captureServerError(new Error('a different header value'), { requestId: 'r2', loadTestHeader: 'yes' });
    await s.reporter.flush(1000);
    assert.equal(s.events().length, 2);
  });
});
