import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { loadAuthConfig } from './config.js';
import { createTokenService, TokenError } from './tokens.js';

const config = loadAuthConfig({});
const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(9);
const userId = randomUUID();
const familyId = randomUUID();

let clock = new Date('2026-10-21T12:00:00.000Z');
const svc = createTokenService({ secret, config, now: () => clock });
const claims = { userId, familyId };

const reasonOf = async (token: string) => {
  try {
    await svc.verify(token);
  } catch (e) {
    assert.ok(e instanceof TokenError, `expected TokenError, got ${String(e)}`);
    return e.reason;
  }
  return 'ACCEPTED';
};

/** A correctly shaped token with chosen overrides, signed by us, so only the thing under test is wrong. */
const forge = (overrides: { alg?: string; iss?: string; aud?: string; sub?: string; sid?: string | null; exp?: Date; key?: Uint8Array; extra?: Record<string, unknown> } = {}) => {
  const payload: Record<string, unknown> = { ...(overrides.extra ?? {}) };
  if (overrides.sid !== null) payload.sid = overrides.sid ?? familyId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: overrides.alg ?? 'HS256' })
    .setSubject(overrides.sub ?? userId)
    .setIssuer(overrides.iss ?? config.issuer)
    .setAudience(overrides.aud ?? config.audience)
    .setIssuedAt(clock)
    .setExpirationTime(overrides.exp ?? new Date(clock.getTime() + 60_000))
    .sign(overrides.key ?? secret);
};

test('a signed token verifies and returns exactly the two IDs; expiry is issuance + 15 minutes', async () => {
  const { token, expiresAt } = await svc.sign(claims);
  assert.equal(expiresAt.getTime() - clock.getTime(), 15 * 60_000);
  assert.deepEqual(await svc.verify(token), claims);
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'sid', 'sub'], 'no role, no team');
  assert.equal(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).alg, 'HS256');
});

test('algorithm confusion: "none" and HS512 are refused', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: userId, sid: familyId, iss: config.issuer, aud: config.audience, iat: 1, exp: 4_000_000_000 })).toString('base64url');
  assert.equal(await reasonOf(`${header}.${body}.`), 'bad_alg');
  assert.equal(await reasonOf(`${header}.${body}.xxxx`), 'bad_alg');
  assert.equal(await reasonOf(await forge({ alg: 'HS512' })), 'bad_alg');
});

test('tampering: a changed payload or signature, or a different secret, is refused', async () => {
  const { token } = await svc.sign(claims);
  const [h, p, s] = token.split('.') as [string, string, string];
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sid: randomUUID() })).toString('base64url');
  assert.equal(await reasonOf(`${h}.${evil}.${s}`), 'bad_signature');
  assert.equal(await reasonOf(`${h}.${p}.${s.slice(0, -2)}AA`), 'bad_signature');
  assert.equal(await reasonOf(await forge({ key: otherSecret })), 'bad_signature');
});

test('expired token is refused, with no clock-skew allowance', async () => {
  const { token } = await svc.sign(claims);
  clock = new Date(clock.getTime() + 15 * 60_000 - 1);
  assert.deepEqual(await svc.verify(token), claims, 'still valid one millisecond before expiry');
  clock = new Date(clock.getTime() + 2_000);
  assert.equal(await reasonOf(token), 'expired');
  clock = new Date('2026-10-21T12:00:00.000Z');
});

test('wrong issuer or audience is refused', async () => {
  assert.equal(await reasonOf(await forge({ iss: 'someone-else' })), 'bad_claim');
  assert.equal(await reasonOf(await forge({ aud: 'another-app' })), 'bad_claim');
});

test('missing or malformed required claims are refused', async () => {
  assert.equal(await reasonOf(await forge({ sid: null })), 'bad_claim');
  assert.equal(await reasonOf(await forge({ sid: 'not-a-uuid' })), 'bad_sid');
  assert.equal(await reasonOf(await forge({ sub: 'not-a-uuid' })), 'bad_sub');
});

test('a role or team claim inside a validly signed token is ignored: only the two IDs come back', async () => {
  const token = await forge({ extra: { role: 'owner', team: randomUUID(), teamId: randomUUID() } });
  assert.deepEqual(await svc.verify(token), claims);
});

test('garbage is refused as malformed', async () => {
  for (const junk of ['', 'abc', 'a.b', 'a.b.c', 'not.a.jwt.at.all']) {
    const reason = await reasonOf(junk);
    assert.notEqual(reason, 'ACCEPTED', junk);
  }
});
