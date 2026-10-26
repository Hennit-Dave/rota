import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmailHandler } from '../jobs/email.js';
import { FakeResend, job } from '../jobs/email.testkit.js';
import { createWorkProcessor } from '../jobs/worker.js';
import { bearer, startAuthTestApp, type TestApp } from './testkit.js';

// Magic link and password reset (ADR 0020, security.md tests 11, 16, 17, 18). Real HTTP server, the TEST shards, a real Valkey with a unique prefix.
// Large rate-limit ceilings here: every request in this file comes from one IP. The limits, the daily cap and the dead-Valkey case have their own apps below.
let app: TestApp;
const big = { max: 10_000, windowSeconds: 3600 };
const BIG_LIMITS = {
  magicRequestIp: big,
  magicRequestEmail: big,
  magicRedeemIp: big,
  resetRequestIp: big,
  resetRequestEmail: big,
  resetSubmitIp: big,
  loginIp: big,
  loginEmail: big,
};

before(async () => {
  app = await startAuthTestApp({ rateLimits: BIG_LIMITS, recovery: { globalDailyCap: 10_000 } });
});
after(() => app.stop());

const NEW_PASSWORD = 'a-brand-new-passphrase-for-rota-1';
// A request answers first and makes the token and email row after (ADR 0020); `settle` waits for that, so the rows can be read.
const requestMagic = async (email: string) => {
  const reply = await app.post('/auth/magic-link/request', { email });
  await app.settle();
  return reply;
};
const requestReset = async (email: string) => {
  const reply = await app.post('/auth/password-reset/request', { email });
  await app.settle();
  return reply;
};
const redeem = (token: string) => app.post('/auth/magic-link/redeem', { token });
const submit = (token: string, password = NEW_PASSWORD) => app.post('/auth/password-reset/submit', { token, password });
const login = (email: string, password: string) => app.post('/auth/login', { email, password });
const me = (accessToken: string) => app.get('/auth/me', bearer(accessToken));
const strip = (r: { status: number; body: any }) => ({ status: r.status, body: r.body && r.body.error ? { ...r.body.error, requestId: '<id>' } : r.body });

async function emailsOf(userId: string, purpose?: string) {
  const all = await app.recoveryEmails(userId);
  return purpose ? all.filter((e) => e.purpose === purpose) : all;
}
async function secretOf(userId: string, purpose: 'magic_link' | 'password_reset'): Promise<string> {
  return (await emailsOf(userId, purpose))[0]!.secret;
}
const expire = (tokenId: string) => app.db.$executeRaw`UPDATE auth_tokens SET expires_at = NOW() - interval '1 second' WHERE id = ${tokenId}::uuid`;
const verify = (userId: string) => app.db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });

for (const [name, path, purpose] of [
  ['magic link', '/auth/magic-link/request', 'magic_link'],
  ['password reset', '/auth/password-reset/request', 'password_reset'],
] as const) {
  test(`${name} request: a known and an unknown address get the IDENTICAL answer; only the known one gets a token, an email row and a job`, async () => {
    const user = await app.seedUser();
    const unknown = app.newEmail();
    const queuedBefore = app.enqueued().length;

    const known = await app.post(path, { email: ` ${user.email.toUpperCase()} ` });
    const none = await app.post(path, { email: unknown });
    await app.settle();
    assert.equal(known.status, 202);
    assert.deepEqual(strip(known), strip(none), 'same status and body');
    assert.equal(known.headers.get('cache-control'), 'no-store');
    assert.equal(none.headers.get('cache-control'), 'no-store');

    const emails = await emailsOf(user.id, purpose);
    assert.equal(emails.length, 1, 'the known address has exactly one token');
    assert.equal(app.enqueued().length, queuedBefore + 1, 'one job was enqueued, for the known address only');
    assert.equal(app.enqueued().at(-1), emails[0]!.workRowId);

    // The frozen email: to the account, from the configured sender, a link to the App Link host with a 43-character secret.
    const [mail] = emails;
    assert.equal(mail!.to, user.email);
    assert.match(mail!.link, new RegExp(`^https://rota\\.davebuilds\\.design/${purpose === 'magic_link' ? 'magic' : 'reset'}/[A-Za-z0-9_-]{43}$`));
    const work = await app.db.workRow.findUniqueOrThrow({ where: { id: mail!.workRowId } });
    assert.equal(work.kind, 'email');
    assert.equal(work.status, 'pending');
    assert.equal(work.originRequestId, known.headers.get('x-request-id'), 'the request that made it is on the row');

    // Only the HASH of the secret is stored, and it is not in the token row in any form.
    const row = await app.db.authToken.findUniqueOrThrow({ where: { id: mail!.tokenId } });
    assert.equal(row.purpose, purpose);
    assert.deepEqual(Buffer.from(row.tokenHash), createHash('sha256').update(mail!.secret).digest());
    assert.equal(JSON.stringify(row).includes(mail!.secret), false);
    assert.equal(row.usedAt, null);
    const minutes = purpose === 'magic_link' ? 10 : 60;
    assert.ok(Math.abs(row.expiresAt.getTime() - (Date.now() + minutes * 60_000)) < 2 * 60_000, `expires about ${minutes} minutes from now`);
  });
}

test('a newer request replaces the older link of the same purpose; the other purpose is untouched', async () => {
  const user = await app.seedUser();
  await requestMagic(user.email);
  await requestReset(user.email);
  const firstMagic = await secretOf(user.id, 'magic_link');
  await requestMagic(user.email);
  const secondMagic = (await emailsOf(user.id, 'magic_link'))[0]!.secret;
  assert.notEqual(firstMagic, secondMagic);

  assert.equal((await redeem(firstMagic)).status, 404, 'the older magic link no longer works');
  assert.equal((await redeem(secondMagic)).status, 200, 'the newer one does');
  // A reset link is a different purpose: replacing and redeeming magic links did not touch it.
  assert.equal((await submit(await secretOf(user.id, 'password_reset'))).status, 204);
});

test('magic link: works once, and the session it returns works', async () => {
  const user = await app.seedUser();
  await verify(user.id);
  await requestMagic(user.email);
  const secret = await secretOf(user.id, 'magic_link');

  const res = await redeem(secret);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.body.user.id, user.id);
  assert.equal(res.body.user.email, user.email);
  assert.equal(res.body.user.emailVerified, true);
  assert.equal((await me(res.body.session.accessToken)).status, 200);

  const again = await redeem(secret);
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'link_unavailable');
  const row = (await emailsOf(user.id, 'magic_link'))[0]!;
  assert.ok((await app.db.authToken.findUniqueOrThrow({ where: { id: row.tokenId } })).usedAt, 'used_at is set');
});

test('magic link: expired, unknown, malformed and replaced links all get ONE identical answer', async () => {
  const user = await app.seedUser();
  await requestMagic(user.email);
  await requestReset(user.email);
  const [row] = await emailsOf(user.id, 'magic_link');
  await expire(row!.tokenId);
  const answers = [
    await redeem(row!.secret), // expired
    await redeem('A'.repeat(43)), // well-formed, unknown
    await redeem('not-a-token'), // not shaped like ours
    await redeem((await emailsOf(user.id, 'password_reset'))[0]?.secret ?? 'B'.repeat(43)), // a reset link is not a magic link
  ];
  for (const a of answers) assert.equal(a.status, 404);
  const [first, ...rest] = answers.map(strip);
  for (const r of rest) assert.deepEqual(r, first);
  assert.equal(first!.body.code, 'link_unavailable');
});

test('opening a link consumes nothing: a GET of the link or of the redeem route changes no token', async () => {
  const user = await app.seedUser();
  await requestMagic(user.email);
  const [row] = await emailsOf(user.id, 'magic_link');
  for (const path of [`/auth/magic-link/redeem?token=${row!.secret}`, `/magic/${row!.secret}`, `/auth/magic-link/${row!.secret}`]) {
    assert.equal((await app.get(path)).status, 404, `GET ${path.replace(row!.secret, '<token>')}`);
  }
  assert.equal((await app.db.authToken.findUniqueOrThrow({ where: { id: row!.tokenId } })).usedAt, null);
  assert.equal((await redeem(row!.secret)).status, 200, 'and the link still works');
});

test('ACCOUNT TAKEOVER BLOCKED: the real owner redeems a magic link for an address someone else registered (unverified): the old password and old sessions die', async () => {
  const squatter = await app.seedUser({ password: 'the-squatters-own-passphrase-1' }); // unverified: signup verification is deferred
  const oldSession = await app.startSession(squatter.id);
  assert.equal((await me(oldSession.accessToken)).status, 200);
  assert.equal((await login(squatter.email, squatter.password)).status, 200);

  await requestMagic(squatter.email); // the real owner of the mailbox asks for a link
  const res = await redeem(await secretOf(squatter.id, 'magic_link'));
  assert.equal(res.status, 200);

  assert.equal((await login(squatter.email, squatter.password)).status, 401, 'the squatter password no longer works');
  assert.equal((await me(oldSession.accessToken)).status, 401, 'the squatter session is rejected');
  assert.equal((await app.post('/auth/refresh', { refreshToken: oldSession.refreshToken })).status, 401, 'and so is its refresh token');
  assert.equal((await me(res.body.session.accessToken)).status, 200, 'the new session works');
  const user = await app.db.user.findUniqueOrThrow({ where: { id: squatter.id }, include: { credential: true } });
  assert.ok(user.emailVerifiedAt, 'the address is now verified');
  assert.equal(user.credential, null, 'the password was cleared');
});

test('a VERIFIED account loses nothing when it redeems a magic link: password and other sessions stay', async () => {
  const owner = await app.seedUser();
  await verify(owner.id);
  const otherDevice = await app.startSession(owner.id);
  await requestMagic(owner.email);
  const res = await redeem(await secretOf(owner.id, 'magic_link'));
  assert.equal(res.status, 200);
  assert.equal((await login(owner.email, owner.password)).status, 200, 'the password still works');
  assert.equal((await me(otherDevice.accessToken)).status, 200, 'the other device is still signed in');
});

test('two simultaneous redemptions of one magic link: exactly one session', async () => {
  const user = await app.seedUser();
  await requestMagic(user.email);
  const secret = await secretOf(user.id, 'magic_link');
  const results = await Promise.all([redeem(secret), redeem(secret), redeem(secret)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404, 404]);
});

test('password reset: works once, then the old password and EVERY session are gone, and nobody is signed in by it', async () => {
  const user = await app.seedUser();
  await verify(user.id);
  const phone = await app.startSession(user.id);
  const tablet = await app.startSession(user.id);
  await requestReset(user.email);
  const secret = await secretOf(user.id, 'password_reset');

  const res = await submit(secret);
  assert.equal(res.status, 204);
  assert.equal(res.text, '', 'no body: no session is returned');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  assert.equal((await me(phone.accessToken)).status, 401);
  assert.equal((await me(tablet.accessToken)).status, 401);
  assert.equal((await app.post('/auth/refresh', { refreshToken: phone.refreshToken })).status, 401);
  assert.equal((await login(user.email, user.password)).status, 401, 'the old password fails');
  const fresh = await login(user.email, NEW_PASSWORD);
  assert.equal(fresh.status, 200, 'the new password works');
  assert.equal((await me(fresh.body.session.accessToken)).status, 200);

  const again = await submit(secret, 'yet-another-passphrase-for-rota-2');
  assert.equal(again.status, 404, 'the link works once');
  assert.equal(again.body.error.code, 'link_unavailable');
  assert.equal((await login(user.email, NEW_PASSWORD)).status, 200, 'and the second attempt changed nothing');
  const families = await app.db.refreshTokenFamily.findMany({ where: { userId: user.id, revokedReason: 'password_reset' } });
  assert.equal(families.length, 2, 'both old sessions were revoked with the reason recorded');
});

test('password reset: an expired, unknown, malformed or replaced link gets ONE identical answer and changes nothing', async () => {
  const user = await app.seedUser();
  await requestReset(user.email);
  const [row] = await emailsOf(user.id, 'password_reset');
  await expire(row!.tokenId);
  const answers = [await submit(row!.secret), await submit('C'.repeat(43)), await submit('not-a-token')];
  for (const a of answers) assert.equal(a.status, 404);
  const [first, ...rest] = answers.map(strip);
  for (const r of rest) assert.deepEqual(r, first);
  assert.equal((await login(user.email, user.password)).status, 200, 'the password did not change');
});

test('password reset: a weak new password is refused with 400 and the link is NOT used up', async () => {
  const user = await app.seedUser();
  await requestReset(user.email);
  const secret = await secretOf(user.id, 'password_reset');
  const weak = await submit(secret, 'short');
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, 'validation_failed');
  assert.equal((await submit(secret)).status, 204, 'the same link still works with a good password');
});

test('password reset: an unverified account is verified by it, and a magic link that cleared the password can be followed by a reset', async () => {
  const user = await app.seedUser();
  await requestMagic(user.email);
  await redeem(await secretOf(user.id, 'magic_link')); // verifies, clears the password
  assert.equal((await app.db.credential.count({ where: { userId: user.id } })), 0);

  await requestReset(user.email);
  assert.equal((await submit(await secretOf(user.id, 'password_reset'))).status, 204);
  assert.equal((await login(user.email, NEW_PASSWORD)).status, 200, 'a password exists again');

  const unverified = await app.seedUser();
  await requestReset(unverified.email);
  await submit(await secretOf(unverified.id, 'password_reset'));
  assert.ok((await app.db.user.findUniqueOrThrow({ where: { id: unverified.id } })).emailVerifiedAt, 'reset proves control of the address');
});

test('a successful reset kills every other outstanding link of that user', async () => {
  const user = await app.seedUser();
  await requestMagic(user.email);
  await requestReset(user.email);
  const magic = await secretOf(user.id, 'magic_link');
  assert.equal((await submit(await secretOf(user.id, 'password_reset'))).status, 204);
  assert.equal((await redeem(magic)).status, 404, 'the magic link sent before the reset is dead');
});

test('two simultaneous resets with one link: exactly one wins, and its password is the one that works', async () => {
  const user = await app.seedUser();
  await requestReset(user.email);
  const secret = await secretOf(user.id, 'password_reset');
  const [a, b] = await Promise.all([submit(secret, 'first-concurrent-passphrase-1'), submit(secret, 'second-concurrent-passphrase-2')]);
  assert.deepEqual([a.status, b.status].sort(), [204, 404]);
  const winner = a.status === 204 ? 'first-concurrent-passphrase-1' : 'second-concurrent-passphrase-2';
  assert.equal((await login(user.email, winner)).status, 200);
});

test('validation: unknown keys, a bad address, a missing token and an oversized token are 400, and nothing is written', async () => {
  const tokensBefore = await app.db.authToken.count();
  const cases: Array<[string, unknown]> = [
    ['/auth/magic-link/request', { email: 'not-an-email' }],
    ['/auth/magic-link/request', { email: 'a@example.com', extra: 1 }],
    ['/auth/password-reset/request', { email: 'a@example.com', extra: 1 }],
    ['/auth/magic-link/redeem', {}],
    ['/auth/magic-link/redeem', { token: 'x'.repeat(201) }],
    ['/auth/password-reset/submit', { token: 'x'.repeat(43) }],
    ['/auth/password-reset/submit', { token: 'x'.repeat(43), password: NEW_PASSWORD, extra: 1 }],
  ];
  for (const [path, body] of cases) {
    const r = await app.post(path, body);
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body).slice(0, 40)}`);
    assert.equal(r.body.error.code, 'validation_failed');
  }
  assert.equal(await app.db.authToken.count(), tokensBefore);
});

test('REDACTION: no link secret and no password appears in the captured logs', async () => {
  const user = await app.seedUser();
  await requestMagic(user.email);
  await requestReset(user.email);
  const magic = await secretOf(user.id, 'magic_link');
  const reset = await secretOf(user.id, 'password_reset');
  await redeem(magic);
  await redeem(magic); // a failure is logged too
  await submit(reset, 'a-passphrase-that-must-not-be-logged-3');
  await submit('D'.repeat(43), 'a-passphrase-that-must-not-be-logged-3');
  const logs = app.logLines().join('\n');
  for (const secret of [magic, reset, 'a-passphrase-that-must-not-be-logged-3', user.email]) {
    assert.equal(logs.includes(secret), false, 'a secret reached the logs');
  }
});

test('the email job: sends once while the link is live, and SKIPS a link that was used, replaced or has expired', async () => {
  const resend = new FakeResend();
  const processor = createWorkProcessor(app.shards, { email: createEmailHandler({ resend }) }, { leaseMs: 10_000, maxAttempts: 5 });
  const run = async (workRowId: string) => {
    // The API stamps run_at from its own clock; make it unambiguously due for the worker's claim.
    await app.db.$executeRaw`UPDATE work_rows SET run_at = NOW() - interval '1 second' WHERE id = ${workRowId}::uuid`;
    await processor(job({ id: workRowId }, 'A'));
    return app.db.workRow.findUniqueOrThrow({ where: { id: workRowId } });
  };

  // Live: sent exactly once, under the stable key, and the body is scrubbed afterwards.
  const live = await app.seedUser();
  await requestReset(live.email);
  const [liveMail] = await emailsOf(live.id, 'password_reset');
  const sent = await run(liveMail!.workRowId);
  assert.equal(resend.deliveries, 1);
  assert.equal(resend.calls[0]!.key, `email-${liveMail!.workRowId}`);
  assert.ok(sent.sentAt);
  assert.equal(JSON.stringify(sent.payload).includes(liveMail!.secret), false, 'the secret is gone from the row after sending');

  // Used before the email went out: skipped, done, never sent.
  const used = await app.seedUser();
  await requestMagic(used.email);
  const [usedMail] = await emailsOf(used.id, 'magic_link');
  await redeem(usedMail!.secret);
  const usedRow = await run(usedMail!.workRowId);
  assert.equal(usedRow.status, 'done');
  assert.equal(usedRow.sentAt, null);

  // Replaced by a newer request: the older email is skipped, the newer is sent.
  const replaced = await app.seedUser();
  await requestReset(replaced.email);
  const older = (await emailsOf(replaced.id, 'password_reset'))[0]!;
  await requestReset(replaced.email);
  const newer = (await emailsOf(replaced.id, 'password_reset'))[0]!;
  assert.notEqual(older.workRowId, newer.workRowId);
  assert.equal((await run(older.workRowId)).sentAt, null, 'the replaced link is not emailed');
  assert.ok((await run(newer.workRowId)).sentAt, 'the current one is');

  // Expired before the worker got to it: skipped.
  const late = await app.seedUser();
  await requestMagic(late.email);
  const [lateMail] = await emailsOf(late.id, 'magic_link');
  await expire(lateMail!.tokenId);
  assert.equal((await run(lateMail!.workRowId)).sentAt, null);
  assert.equal(resend.deliveries, 2, 'two real deliveries in all: the live reset and the current replacement');
});

test('RATE LIMITS: a request is limited per address, counted for unknown addresses too, so a 429 reveals nothing', async () => {
  const limited = await startAuthTestApp({
    rateLimits: { ...BIG_LIMITS, magicRequestEmail: { max: 2, windowSeconds: 900 }, resetRequestEmail: { max: 2, windowSeconds: 900 } },
    recovery: { globalDailyCap: 10_000 },
  });
  try {
    for (const path of ['/auth/magic-link/request', '/auth/password-reset/request']) {
      const user = await limited.seedUser();
      const unknown = limited.newEmail();
      for (const email of [user.email, unknown]) {
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await limited.post(path, { email })).status);
        assert.deepEqual(codes, [202, 202, 429, 429], `${path} for ${email === user.email ? 'a known' : 'an unknown'} address`);
      }
      const blocked = await limited.post(path, { email: user.email });
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    }
  } finally {
    await limited.stop();
  }
});

test('RATE LIMITS: submitting a reset and redeeming a magic link are limited per IP, and a blocked attempt never costs an Argon2 run', async () => {
  const limited = await startAuthTestApp({
    rateLimits: { ...BIG_LIMITS, resetSubmitIp: { max: 2, windowSeconds: 900 }, magicRedeemIp: { max: 2, windowSeconds: 900 } },
    recovery: { globalDailyCap: 10_000 },
  });
  try {
    const bad = 'E'.repeat(43);
    const body = { token: bad, password: NEW_PASSWORD };
    assert.equal((await limited.post('/auth/password-reset/submit', body)).status, 404);
    assert.equal((await limited.post('/auth/password-reset/submit', body)).status, 404);
    const hashesBefore = limited.hashCount();
    const blocked = await limited.post('/auth/password-reset/submit', body);
    assert.equal(blocked.status, 429);
    assert.equal(limited.hashCount(), hashesBefore, 'no password was hashed for a blocked attempt');

    assert.equal((await limited.post('/auth/magic-link/redeem', { token: bad })).status, 404);
    assert.equal((await limited.post('/auth/magic-link/redeem', { token: bad })).status, 404);
    assert.equal((await limited.post('/auth/magic-link/redeem', { token: bad })).status, 429);
  } finally {
    await limited.stop();
  }
});

test('the app-wide daily cap: when it is spent no more emails are made, and the answer is still the same 202', async () => {
  const capped = await startAuthTestApp({ rateLimits: BIG_LIMITS, recovery: { globalDailyCap: 1 } });
  try {
    const a = await capped.seedUser();
    const b = await capped.seedUser();
    const unknown = capped.newEmail();
    const first = await capped.post('/auth/magic-link/request', { email: a.email });
    const second = await capped.post('/auth/password-reset/request', { email: b.email }); // shares the cap with magic link
    const none = await capped.post('/auth/magic-link/request', { email: unknown });
    await capped.settle();
    assert.deepEqual([first.status, second.status, none.status], [202, 202, 202]);
    assert.deepEqual(strip(first), strip(second));
    assert.equal((await capped.recoveryEmails(a.id)).length, 1, 'the first request used the cap');
    assert.equal((await capped.recoveryEmails(b.id)).length, 0, 'the second found it spent: no token, no email');
    assert.equal(capped.enqueued().length, 1);
    assert.ok(capped.logLines().some((l) => l.includes('recovery_email_cap_reached')), 'the spent cap is logged for us');
    // An unknown address never uses the cap, so it cannot be burned with made-up addresses.
    const c = await capped.seedUser();
    assert.equal((await capped.post('/auth/magic-link/request', { email: capped.newEmail() })).status, 202);
    await capped.settle();
    assert.equal((await capped.recoveryEmails(c.id)).length, 0);
  } finally {
    await capped.stop();
  }
});

test('Valkey down: all four routes fail closed with 503 and write nothing', async () => {
  const dead = await startAuthTestApp({ deadValkey: true });
  try {
    const user = await dead.seedUser();
    const tokensBefore = await dead.db.authToken.count();
    for (const [path, body] of [
      ['/auth/magic-link/request', { email: user.email }],
      ['/auth/password-reset/request', { email: user.email }],
      ['/auth/magic-link/redeem', { token: 'F'.repeat(43) }],
      ['/auth/password-reset/submit', { token: 'F'.repeat(43), password: NEW_PASSWORD }],
    ] as const) {
      const r = await dead.post(path, body);
      assert.equal(r.status, 503, path);
      assert.equal(r.body.error.code, 'service_unavailable');
    }
    assert.equal(await dead.db.authToken.count(), tokensBefore);
  } finally {
    await dead.stop();
  }
});

test('the identical-answer check compares a real unknown address with a random one, not just the status', async () => {
  const user = await app.seedUser();
  const a = await requestMagic(user.email);
  const b = await requestMagic(`nobody-${randomUUID()}@example.com`);
  assert.equal(a.text, b.text, 'the response bodies are byte-identical');
  assert.equal([...a.headers.keys()].filter((h) => !['date', 'x-request-id', 'etag', 'content-length'].includes(h)).sort().join(','),
    [...b.headers.keys()].filter((h) => !['date', 'x-request-id', 'etag', 'content-length'].includes(h)).sort().join(','), 'and so are the header names');
});

test('TIMING: the answer does not wait for the token, the email row or the job, so a known address takes no longer to answer than an unknown one', async () => {
  const user = await app.seedUser();
  const release = app.holdEnqueue(); // the last step of making the email is stuck until we let go
  const queuedBefore = app.enqueued().length;
  const started = Date.now();
  const reply = await app.post('/auth/password-reset/request', { email: user.email });
  assert.equal(reply.status, 202, 'answered while the email was still being made');
  assert.equal(app.enqueued().length, queuedBefore, 'the job had not been enqueued when the answer arrived');
  assert.ok(Date.now() - started < 5_000);
  release();
  await app.settle();
  assert.equal(app.enqueued().length, queuedBefore + 1, 'and it is enqueued once the step finishes: nothing was dropped');
  assert.equal((await emailsOf(user.id, 'password_reset')).length, 1);
});

test('a failure in the step after the answer is logged, never thrown at anyone, and the committed rows stay for the sweep', async () => {
  const failing = await startAuthTestApp({ rateLimits: BIG_LIMITS, recovery: { globalDailyCap: 10_000 }, failEnqueue: true });
  try {
    const owner = await failing.seedUser();
    const reply = await failing.post('/auth/password-reset/request', { email: owner.email });
    await failing.settle();
    assert.equal(reply.status, 202, 'the answer was already the same 202');
    assert.ok(failing.logLines().some((l) => l.includes('recovery_task_failed')), 'the failure is in our logs');
    const [mail] = await failing.recoveryEmails(owner.id);
    assert.ok(mail, 'the token and the email row were committed together before the enqueue was tried');
    const work = await failing.db.workRow.findUniqueOrThrow({ where: { id: mail!.workRowId } });
    assert.equal(work.status, 'pending', 'still pending: the reconciliation sweep enqueues it (jobs.md)');
    assert.equal(failing.enqueued().length, 0);
  } finally {
    await failing.stop();
  }
});
