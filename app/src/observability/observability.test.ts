import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ConfigError } from '../api/config';
import { ApiError, NetworkError, NotSignedInError, OfflineError, RefreshUncertainError, RefreshUnavailableError, SessionEndedError, StaleAccountError } from '../api/errors';
import { isReportableError, requestIdOf } from './reportable';
import { createEventGate, REDACTED, scrubBreadcrumb, scrubEvent, scrubString } from './sentryScrub';

const here = dirname(fileURLToPath(import.meta.url));
const TEAM = '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b';
const TOKEN = `${TEAM}.${'A'.repeat(42)}-`;

describe('the redaction list is the same file as the server uses', () => {
  it('app/src/observability/sentryScrub.ts is byte for byte shared/sentry-scrub.ts', () => {
    const canonical = readFileSync(join(here, '../../../shared/sentry-scrub.ts'), 'utf8');
    assert.equal(readFileSync(join(here, 'sentryScrub.ts'), 'utf8'), canonical, 'run: node shared/sync-sentry-scrub.mjs');
  });
});

describe('which errors are worth a Sentry event (ADR 0039)', () => {
  const api = (status: number, code = 'x', requestId: string | null = 'req-1') => new ApiError(status, code, 'm', requestId);

  it('ordinary failures are NOT reported: offline, a lost connection, signed out, a session that ended, an undecided refresh, a changed account', () => {
    for (const e of [new OfflineError(), new NetworkError('timed out', true), new NotSignedInError(), new SessionEndedError('refresh_rejected'), new RefreshUnavailableError(503, null), new RefreshUncertainError('lost'), new StaleAccountError()]) {
      assert.equal(isReportableError(e), false, e.name);
    }
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = Object.assign(new Error('cancelled'), { name: 'CancelledError' });
    assert.equal(isReportableError(abort), false);
    assert.equal(isReportableError(cancelled), false);
  });

  it('an answer from the server below 500 is not reported (the server said no for a reason), and neither is 503 (briefly unavailable; the API reports it itself)', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 503]) assert.equal(isReportableError(api(status)), false, String(status));
  });

  it('a server error (500 and above, except 503) IS reported, and carries its request ID so it can be joined to the API\'s own event', () => {
    for (const status of [500, 501, 502, 504]) assert.equal(isReportableError(api(status)), true, String(status));
    assert.equal(requestIdOf(api(500, 'internal_error', 'abc-123')), 'abc-123');
    assert.equal(requestIdOf(api(500, 'internal_error', null)), null);
    assert.equal(requestIdOf(new Error('x')), null);
  });

  it('a bug is reported: a thrown TypeError, a bad configuration, anything that is not one of the expected errors', () => {
    assert.equal(isReportableError(new TypeError('undefined is not a function')), true);
    assert.equal(isReportableError(new ConfigError('EXPO_PUBLIC_API_URL is not set.')), true);
    assert.equal(isReportableError('a string was thrown'), true);
    assert.equal(isReportableError(undefined), true);
  });
});

describe('breadcrumbs and events in the app (the links must never leave with their tokens)', () => {
  it('a navigation breadcrumb to an invite, magic or reset link loses the token and the query string (docs/SECURITY.md)', () => {
    for (const path of [`/invite/${TOKEN}`, `/magic/${'B'.repeat(43)}`, `/reset/${'C'.repeat(43)}`]) {
      const crumb = scrubBreadcrumb({ category: 'navigation', data: { from: '/(auth)/sign-in', to: `${path}?utm=1#top` } })!;
      const data = crumb.data as { from: string; to: string };
      assert.equal(data.from, '/(auth)/sign-in');
      assert.match(data.to, /\[redacted\]$/);
      assert.ok(!JSON.stringify(crumb).includes('AAAAAAAA') && !JSON.stringify(crumb).includes('BBBBBBBB') && !JSON.stringify(crumb).includes('CCCCCCCC'));
      assert.ok(!JSON.stringify(crumb).includes('utm=1'));
    }
  });

  it('a request breadcrumb loses its query string, and a console breadcrumb is dropped', () => {
    const xhr = scrubBreadcrumb({ category: 'xhr', data: { url: `https://api.example.com/teams/${TEAM}/shifts?from=2031-03-03&to=2031-03-10`, method: 'GET', status_code: 200 } })!;
    assert.equal((xhr.data as { url: string }).url, `https://api.example.com/teams/${TEAM}/shifts`);
    assert.equal(scrubBreadcrumb({ category: 'console', message: 'a log line with sam@example.com' }), null);
  });

  it('every app event carries the placeholder address 0.0.0.0 (it is what stops Sentry inferring a geography), and a URL inside a message loses its query string', () => {
    const out = scrubEvent({ user: { id: 'u1', ip_address: '203.0.113.9' }, message: `failed: https://api.example.com/auth/magic?token=abc and ${TOKEN}` }) as any;
    assert.deepEqual(out.user, { id: 'u1', ip_address: '0.0.0.0' });
    assert.ok(!JSON.stringify(out).includes('203.0.113.9') && !JSON.stringify(out).includes('token=abc'));
    assert.equal(out.message.startsWith('failed: https://api.example.com/auth/magic and'), true);
    assert.deepEqual((scrubEvent({ message: 'signed out' }) as any).user, { ip_address: '0.0.0.0' });
  });

  it('an app error event keeps its tags and user id, and loses the email, the token and the card in it', () => {
    const out = scrubEvent({
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'sam@example.com', ip_address: '203.0.113.9' },
      exception: { values: [{ type: 'Error', value: `invite ${TOKEN} for sam@example.com failed; card 4242 4242 4242 4242` }] },
      tags: { request_id: 'req-1', team_id: TEAM },
    }) as any;
    assert.deepEqual(out.user, { id: '11111111-1111-4111-8111-111111111111', ip_address: '0.0.0.0' });
    assert.deepEqual(out.tags, { request_id: 'req-1', team_id: TEAM });
    const text = JSON.stringify(out);
    for (const secret of ['sam@example.com', '4242 4242', 'AAAAAAAAAA', '203.0.113.9']) assert.ok(!text.includes(secret), secret);
    assert.ok(text.includes(REDACTED));
  });
});

describe('the app session limit (20 in all; chosen, not measured; approved by Dave 2026-11-04)', () => {
  it('20 different errors go, the 21st does not, and the same error is not sent twice in 5 minutes', () => {
    let t = 0;
    const gate = createEventGate({ dedupeMs: 5 * 60_000, maxPerMinute: 10, maxTotal: 20, totalWindowMs: Number.POSITIVE_INFINITY, now: () => t });
    for (let i = 0; i < 20; i++) {
      t += 70_000;
      assert.equal(gate.check(`e${i}`), 'send');
    }
    t += 70_000;
    assert.equal(gate.check('e21'), 'cap_reached');

    t = 0;
    const second = createEventGate({ dedupeMs: 5 * 60_000, maxPerMinute: 10, maxTotal: 20, totalWindowMs: Number.POSITIVE_INFINITY, now: () => t });
    assert.equal(second.check('same'), 'send');
    t += 4 * 60_000;
    assert.equal(second.check('same'), 'duplicate');
    t += 2 * 60_000;
    assert.equal(second.check('same'), 'send', 'after 5 minutes it may go again');
  });

  it('scrubString removes the same things as on the server (a smoke test of the shared list)', () => {
    assert.ok(!scrubString('Bearer abcdefghijklmnop and sk_test_abcdefghijklmnopqr and a@b.co').match(/abcdefghijklmnop|a@b\.co/));
  });
});
