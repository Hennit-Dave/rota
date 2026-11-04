import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createEventGate, fingerprintOf, isSensitiveKey, REDACTED, scrubBreadcrumb, scrubEvent, scrubString, scrubUrl, scrubValue } from './sentryScrub.js';

// The ONE redaction list (shared/sentry-scrub.ts, ADR 0039), tested through the server's copy. The app's own test proves its copy is the same file.
const here = dirname(fileURLToPath(import.meta.url));

const TEAM = '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b';
const b64url = (n: number) => randomBytes(n).toString('base64url').slice(0, n);
const INVITE_SECRET = b64url(43);
const INVITE_TOKEN = `${TEAM}.${INVITE_SECRET}`;
const JWT = `eyJhbGciOiJIUzI1NiJ9.${b64url(40)}.${b64url(43)}`;
const STRIPE_SK = `sk_test_${b64url(24)}`;
const STRIPE_WHSEC = `whsec_${b64url(32)}`;
const PI = `pi_3${b64url(22)}`;
const PI_SECRET = `${PI}_secret_${b64url(24)}`;
const RESEND = `re_${b64url(30)}`;

/** Every one of these must be gone from the output. */
const SECRETS: Array<[string, string]> = [
  ['a bearer token', `Authorization: Bearer ${JWT}`],
  ['a JWT', `token was ${JWT} here`],
  ['an invite token', `link ${INVITE_TOKEN} failed`],
  ['an invite URL', `https://rota.davebuilds.design/invite/${INVITE_TOKEN}`],
  ['a magic link', `GET /magic/${b64url(43)} 400`],
  ['a reset link', `https://rota.davebuilds.design/reset/${b64url(43)}?x=1`],
  ['a token in a query string', `/auth/magic?token=${b64url(30)}&next=1`],
  ['an email address', 'sam.o\'brien+shifts@example.co.uk could not be reached'],
  ['a card number', 'card 4242 4242 4242 4242 was declined'],
  ['a card number with dashes', 'card 5555-5555-5555-4444 was declined'],
  ['a Stripe secret key', `using ${STRIPE_SK}`],
  ['a Stripe webhook secret', `signing with ${STRIPE_WHSEC}`],
  ['a PaymentIntent id', `payment ${PI} failed`],
  ['a PaymentIntent client secret', `client ${PI_SECRET}`],
  ['a payment method id', `pm_1${b64url(22)} was detached`],
  ['a customer id', `cus_${b64url(16)} has no card`],
  ['a Resend key', `RESEND_API_KEY=${RESEND}`],
  ['a password in a URL', 'postgresql://app_user:s3cr3t-Passw0rd@ep-x-pooler.c-2.eu-west-2.aws.neon.tech/neondb'],
];

describe('the shared list is the same file in the server', () => {
  it('server/src/observability/sentryScrub.ts is byte for byte shared/sentry-scrub.ts', () => {
    const canonical = readFileSync(join(here, '../../../shared/sentry-scrub.ts'), 'utf8');
    assert.equal(readFileSync(join(here, 'sentryScrub.ts'), 'utf8'), canonical, 'run: node shared/sync-sentry-scrub.mjs');
  });
});

describe('strings that look like secrets are scrubbed', () => {
  for (const [name, text] of SECRETS) {
    it(`${name}`, () => {
      const out = scrubString(text);
      assert.ok(out.includes(REDACTED), `${out}`);
      for (const piece of [INVITE_SECRET, JWT.split('.')[1]!, STRIPE_SK, STRIPE_WHSEC, 'sam.o', '4242 4242', '5555-5555', 's3cr3t', RESEND, PI.slice(0, 20)]) {
        if (text.includes(piece)) assert.ok(!out.includes(piece), `${piece} survived in: ${out}`);
      }
    });
  }

  it('the edge cases of random tokens: a secret that starts or ends with - or _ is still removed whole (base64url uses both)', () => {
    const edge = ['-', '_'].flatMap((c) => [`${c}${'A'.repeat(42)}`, `${'A'.repeat(42)}${c}`, `${c}${'A'.repeat(41)}${c}`]);
    for (const secret43 of edge) {
      assert.equal(secret43.length, 43);
      for (const text of [`token ${TEAM}.${secret43}`, `${TEAM}.${secret43}`, `${TEAM}.${secret43}.`, `(${TEAM}.${secret43})`, `/invite/${TEAM}.${secret43}?x=1`]) {
        const out = scrubString(text);
        assert.ok(!out.includes(secret43), `${secret43} survived in: ${out}`);
      }
    }
    for (const body of ['_' + 'x'.repeat(30), '-' + 'x'.repeat(30), 'x'.repeat(30) + '_', 'x'.repeat(30) + '-', 'a-b_c-d_e-f_g-h_i-j_k-l_m']) {
      for (const secret of [`sk_test_${body}`, `whsec_${body}`, `${PI}_secret_${body}`, `re_${body}`, `pm_${body}`]) {
        const out = scrubString(`using ${secret} now`);
        assert.ok(!out.includes(body), `${body} survived in: ${out}`);
      }
    }
  });

  it('ordinary text and identifiers that help debugging are left alone', () => {
    for (const keep of [
      `team ${TEAM} request ${'0b8a2f6e-5a54-4c53-9a63-2c9d3f0e8d11'}`,
      '/teams/:teamId/shifts',
      'GET /teams/:teamId/activity 503 in 41 ms',
      'renewal in_progress for retry_requested',
      'shift starts 2031-03-04T09:00:00.123Z and ends 2031-03-04T17:00:00.000Z',
      'Error: relation "shifts" does not exist',
      'epoch 1730000000000 is not a card',
      'seat limit reached: 5 of 5',
    ]) {
      assert.equal(scrubString(keep), keep);
    }
  });
});

describe('keys', () => {
  it('names that suggest a secret, a person or a payment are sensitive, at any depth', () => {
    for (const key of [
      'Authorization', 'authorization', 'Cookie', 'set-cookie', 'password', 'newPassword', 'currentPassword', 'token', 'accessToken', 'refreshToken', 'expoPushToken', 'deviceToken',
      'x-api-key', 'stripe-signature', 'client_secret', 'email', 'emailAddress', 'cardNumber', 'card', 'cardBrand', 'last4', 'expMonth', 'expYear', 'cvc', 'paymentMethod',
      'payment_intent', 'paymentIntentId', 'amount', 'amountCents', 'jwt', 'credentials',
    ]) {
      assert.equal(isSensitiveKey(key), true, key);
    }
    for (const key of ['requestId', 'request_id', 'teamId', 'team_id', 'route', 'status', 'shiftId', 'role', 'attempt', 'jobKind', 'dbRoute', 'cache']) {
      assert.equal(isSensitiveKey(key), false, key);
    }
  });

  it('scrubValue replaces what is under a sensitive key, scrubs strings deeper down, and does not change its input', () => {
    const input = {
      requestId: 'abc',
      headers: { Authorization: `Bearer ${JWT}`, 'x-request-id': 'r1' },
      body: { email: 'a@b.co', nested: { password: 'hunter2', note: `see ${INVITE_TOKEN}` } },
      list: [{ refreshToken: 'x' }, 'mail me at a@b.co'],
      url: `https://x/invite/${INVITE_TOKEN}?a=1`,
    };
    const copy = JSON.stringify(input);
    const out = scrubValue(input) as Record<string, any>;
    assert.equal(JSON.stringify(input), copy, 'the input is untouched');
    assert.equal(out.requestId, 'abc');
    assert.equal(out.headers.Authorization, REDACTED);
    assert.equal(out.headers['x-request-id'], 'r1');
    assert.equal(out.body.email, REDACTED);
    assert.equal(out.body.nested.password, REDACTED);
    assert.ok(!out.body.nested.note.includes(INVITE_SECRET));
    assert.equal(out.list[0].refreshToken, REDACTED);
    assert.equal(out.list[1], `mail me at ${REDACTED}`);
    assert.equal(out.url, `https://x/invite/${REDACTED}`, 'a url loses its query string and its token');
  });

  it('cuts a value that goes too deep instead of walking it for ever', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    assert.match(JSON.stringify(scrubValue(deep)), /too deep/);
  });
});

describe('urls', () => {
  it('lose the query string, the fragment, the token in the path and any credentials', () => {
    assert.equal(scrubUrl(`https://rota.davebuilds.design/invite/${INVITE_TOKEN}?utm=1#top`), `https://rota.davebuilds.design/invite/${REDACTED}`);
    assert.equal(scrubUrl(`/teams/${TEAM}/shifts?from=2031-03-03&to=2031-03-10`), `/teams/${TEAM}/shifts`);
    assert.equal(scrubUrl('https://user:pw@example.com/path'), `https://${REDACTED}@example.com/path`);
    assert.equal(scrubUrl('/magic/abcdefghijklmnop'), `/magic/${REDACTED}`);
    assert.equal(scrubUrl('/reset/abcdefghijklmnop'), `/reset/${REDACTED}`);
  });
});

describe('breadcrumbs', () => {
  it('a console breadcrumb is dropped; the others lose their secrets; a navigation or request URL loses its query string and token', () => {
    assert.equal(scrubBreadcrumb({ category: 'console', message: 'anything' }), null);
    const xhr = scrubBreadcrumb({ category: 'xhr', data: { url: `https://api.example.com/invitations/accept?token=${b64url(30)}`, method: 'POST', status_code: 400 } })!;
    assert.deepEqual(xhr.data, { url: 'https://api.example.com/invitations/accept', method: 'POST', status_code: 400 });
    const nav = scrubBreadcrumb({ category: 'navigation', data: { from: '/(app)/index', to: `/invite/${INVITE_TOKEN}` } })!;
    assert.deepEqual(nav.data, { from: '/(app)/index', to: `/invite/${REDACTED}` });
    assert.equal(scrubBreadcrumb({ category: 'ui.click', message: 'pressed a@b.co' })!.message, `pressed ${REDACTED}`);
  });
});

describe('an error event is cut down before it leaves (the whole point)', () => {
  const event = () => ({
    event_id: 'e1',
    message: `failed for sam@example.com with ${JWT}`,
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'sam@example.com', username: 'sam', ip_address: '203.0.113.9', geo: { city: 'London' } },
    request: {
      url: `https://api.example.com/invitations/accept?token=${INVITE_SECRET}`,
      method: 'POST',
      headers: { authorization: `Bearer ${JWT}`, cookie: 'sid=abc' },
      cookies: { sid: 'abc' },
      data: { token: INVITE_TOKEN, password: 'hunter2' },
      query_string: `token=${INVITE_SECRET}`,
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `could not charge ${PI} for sam@example.com using ${STRIPE_SK}`,
          stacktrace: { frames: [{ filename: 'dist/billing/renewal.js', function: 'charge', lineno: 10, vars: { card: '4242424242424242', secret: STRIPE_WHSEC }, context_line: `const key = '${STRIPE_SK}'` }] },
        },
      ],
    },
    tags: { request_id: 'r-1', team_id: TEAM, route: '/teams/:teamId/billing' },
    extra: { cardNumber: '4242424242424242', note: `invite ${INVITE_TOKEN}`, attempt: 2 },
    contexts: { runtime: { name: 'node', version: 'v24' }, app: { authToken: 'x' } },
    breadcrumbs: [{ category: 'console', message: 'secret log' }, { category: 'http', data: { url: `https://x/?token=${INVITE_SECRET}` } }],
  });

  it('sends the user id and nothing else about the user, and no request at all', () => {
    const out = scrubEvent(event()) as any;
    assert.deepEqual(out.user, { id: '11111111-1111-4111-8111-111111111111' });
    assert.equal(out.request, undefined);
  });

  it('after scrubbing, none of the secrets can be found anywhere in the serialized event, and the useful parts are still there', () => {
    const out = scrubEvent(event());
    const text = JSON.stringify(out);
    for (const secret of [JWT, JWT.split('.')[1]!, INVITE_SECRET, INVITE_TOKEN, STRIPE_SK, STRIPE_WHSEC, PI, 'sam@example.com', '4242424242424242', 'hunter2', '203.0.113.9', 'sid=abc', 'secret log']) {
      assert.ok(!text.includes(secret), `${secret.slice(0, 12)}... survived`);
    }
    const o = out as any;
    assert.equal(o.tags.request_id, 'r-1');
    assert.equal(o.tags.team_id, TEAM);
    assert.equal(o.tags.route, '/teams/:teamId/billing');
    assert.equal(o.exception.values[0].type, 'Error');
    assert.equal(o.exception.values[0].stacktrace.frames[0].function, 'charge');
    assert.equal(o.exception.values[0].stacktrace.frames[0].lineno, 10);
    assert.equal(o.extra.attempt, 2);
    assert.equal(o.contexts.runtime.name, 'node');
    assert.equal(o.breadcrumbs.length, 1, 'the console breadcrumb is gone');
  });

  it('stack frames lose their variable values and source lines', () => {
    const frame = (scrubEvent(event()) as any).exception.values[0].stacktrace.frames[0];
    assert.equal(frame.vars, undefined);
    assert.equal(frame.context_line, undefined);
  });

  it('does not change the event it was given', () => {
    const e = event();
    const before = JSON.stringify(e);
    scrubEvent(e);
    assert.equal(JSON.stringify(e), before);
  });

  it('an event with no user and no exception is still fine', () => {
    assert.deepEqual(scrubEvent({ message: 'hello' }), { message: 'hello', user: undefined });
  });
});

describe('the fingerprint says "the same error"', () => {
  const ev = (value: string, fn = 'run', type = 'Error') => ({ exception: { values: [{ type, value, stacktrace: { frames: [{ filename: 'a.js', function: fn }] } }] } });
  it('ignores ids and numbers; tells apart the type, the place and the wording', () => {
    assert.equal(fingerprintOf(ev(`row 12 of team ${TEAM} missing`)), fingerprintOf(ev('row 99 of team 0b8a2f6e-5a54-4c53-9a63-2c9d3f0e8d11 missing')));
    assert.notEqual(fingerprintOf(ev('a')), fingerprintOf(ev('b')));
    assert.notEqual(fingerprintOf(ev('a', 'run')), fingerprintOf(ev('a', 'other')));
    assert.notEqual(fingerprintOf(ev('a', 'run', 'TypeError')), fingerprintOf(ev('a', 'run', 'Error')));
  });
});

describe('the gate that limits what leaves (chosen, not measured; approved by Dave 2026-11-04)', () => {
  const MIN = 60_000;
  const server = (now: () => number) => createEventGate({ dedupeMs: 5 * MIN, maxPerMinute: 10, maxTotal: 50, totalWindowMs: 24 * 60 * MIN, now });

  it('the same error is sent once in 5 minutes, then again after', () => {
    let t = 0;
    const gate = server(() => t);
    assert.equal(gate.check('a'), 'send');
    t += 4 * MIN + 59_000;
    assert.equal(gate.check('a'), 'duplicate');
    t += 2_000;
    assert.equal(gate.check('a'), 'send');
  });

  it('at most 10 in a minute, and the 11th is allowed once a minute has passed', () => {
    let t = 0;
    const gate = server(() => t);
    for (let i = 0; i < 10; i++) assert.equal(gate.check(`e${i}`), 'send');
    assert.equal(gate.check('e10'), 'rate_limited');
    t += MIN;
    assert.equal(gate.check('e10'), 'send');
  });

  it('50 in a day per process, then nothing until the day has rolled over', () => {
    let t = 0;
    const gate = server(() => t);
    for (let i = 0; i < 50; i++) {
      t += 6 * MIN; // slow enough for the per-minute limit, fast enough to stay inside one day (50 x 6 min = 5 h)
      assert.equal(gate.check(`e${i}`), 'send', `event ${i}`);
    }
    t += 6 * MIN;
    assert.equal(gate.check('one-more'), 'cap_reached');
    t += 24 * 60 * MIN;
    assert.equal(gate.check('one-more'), 'send', 'a day later the budget is back');
  });

  it('a duplicate is turned away before the budget is looked at, so it never uses any of it up', () => {
    let t = 0;
    const gate = createEventGate({ dedupeMs: 5 * MIN, maxPerMinute: 10, maxTotal: 2, totalWindowMs: 24 * 60 * MIN, now: () => t });
    assert.equal(gate.check('a'), 'send');
    for (let i = 0; i < 20; i++) assert.equal(gate.check('a'), 'duplicate');
    assert.equal(gate.check('b'), 'send', 'twenty repeats of "a" left room for "b"');
    assert.equal(gate.check('c'), 'cap_reached', 'only a and b counted');
    assert.equal(gate.check('b'), 'duplicate');
  });

  it('an app session: 20 in all, with no daily window', () => {
    let t = 0;
    const gate = createEventGate({ dedupeMs: 5 * MIN, maxPerMinute: 10, maxTotal: 20, totalWindowMs: Number.POSITIVE_INFINITY, now: () => t });
    for (let i = 0; i < 20; i++) {
      t += 10_000 * 7; // 70 s apart, so the per-minute limit never applies
      assert.equal(gate.check(`e${i}`), 'send');
    }
    t += 10 * 24 * 60 * MIN;
    assert.equal(gate.check('later'), 'cap_reached', 'it does not reset by itself: a session is a session');
  });
});
