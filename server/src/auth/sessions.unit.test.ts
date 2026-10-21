import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  authTransaction,
  createSession,
  hashRefreshToken,
  newRefreshToken,
  REFRESH_TOKEN_PATTERN,
  revokeAllFamilies,
  revokeFamily,
  rotateRefreshToken,
} from './sessions.js';
import { loadAuthConfig } from './config.js';

test('a refresh token is 32 random bytes in base64url (43 characters), unique, and matches the pattern', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const { token } = newRefreshToken();
    assert.match(token, REFRESH_TOKEN_PATTERN);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    seen.add(token);
  }
  assert.equal(seen.size, 200);
  assert.doesNotMatch('short', REFRESH_TOKEN_PATTERN);
  assert.doesNotMatch('x'.repeat(44), REFRESH_TOKEN_PATTERN);
  assert.doesNotMatch('x'.repeat(42) + '=', REFRESH_TOKEN_PATTERN);
});

test('only the SHA-256 is derived for storage, and it is deterministic', () => {
  const { token, hash } = newRefreshToken();
  assert.equal(hash.length, 32);
  assert.deepEqual(Buffer.from(hash), createHash('sha256').update(token).digest());
  assert.deepEqual(hashRefreshToken(token), hash);
  assert.notDeepEqual(Buffer.from(hash), Buffer.from(token));
});

test('createSession: family absolute expiry = now + 90 days; first token idle expiry = now + 30 days', async () => {
  const written: { family?: { userId: string; absoluteExpiresAt: Date }; token?: { familyId: string; tokenHash: Uint8Array; idleExpiresAt: Date } } = {};
  const fakeDb = {
    refreshTokenFamily: { create: async ({ data }: { data: { userId: string; absoluteExpiresAt: Date } }) => ((written.family = data), { id: 'fam-1' }) },
    refreshToken: { create: async ({ data }: { data: { familyId: string; tokenHash: Uint8Array; idleExpiresAt: Date } }) => ((written.token = data), {}) },
  };
  const now = new Date('2026-10-21T12:00:00.000Z');
  const s = await createSession(fakeDb as never, { userId: 'u1', config: loadAuthConfig({}), now });
  const day = 86_400_000;
  assert.equal(s.familyId, 'fam-1');
  assert.equal(written.family!.absoluteExpiresAt.getTime() - now.getTime(), 90 * day);
  assert.equal(written.token!.idleExpiresAt.getTime() - now.getTime(), 30 * day);
  assert.equal(written.token!.familyId, 'fam-1');
  assert.deepEqual(Buffer.from(written.token!.tokenHash), createHash('sha256').update(s.refreshToken).digest());
});

test('a first token never outlives its family, even with a short absolute lifetime', async () => {
  const written: { abs?: Date; idle?: Date } = {};
  const fakeDb = {
    refreshTokenFamily: { create: async ({ data }: { data: { absoluteExpiresAt: Date } }) => ((written.abs = data.absoluteExpiresAt), { id: 'f' }) },
    refreshToken: { create: async ({ data }: { data: { idleExpiresAt: Date } }) => ((written.idle = data.idleExpiresAt), {}) },
  };
  await createSession(fakeDb as never, { userId: 'u', config: loadAuthConfig({ AUTH_SESSION_ABSOLUTE_DAYS: '10' }), now: new Date() });
  assert.equal(written.idle!.getTime(), written.abs!.getTime());
});

test('every auth transaction is started with the configured maxWait, not Prisma\'s 2 s default', async () => {
  const seen: unknown[] = [];
  const db: any = {
    refreshToken: { findUnique: async () => ({ id: 'a', familyId: 'b' }) },
    $transaction: async (_fn: unknown, options: unknown) => (seen.push(options), 0),
  };
  const config = { ...loadAuthConfig({}), transactionMaxWaitMs: 4321 };
  await authTransaction(db, config, async () => 1);
  await rotateRefreshToken(db, { token: 'x', config, now: new Date() });
  await revokeFamily(db, { userId: 'u', familyId: 'f', config });
  await revokeAllFamilies(db, { userId: 'u', config });
  assert.deepEqual(seen, [{ maxWait: 4321 }, { maxWait: 4321 }, { maxWait: 4321 }, { maxWait: 4321 }]);
});
