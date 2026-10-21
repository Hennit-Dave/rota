import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { AuthConfig } from './config.js';

/**
 * Sessions = refresh-token families (ADR 0005). One family per device login. Refresh tokens are 32 random
 * bytes, base64url; only their SHA-256 is stored. SHA-256 is fine here, unlike for a password, because the
 * token is high-entropy random data, so there is nothing to brute-force.
 */
export const REFRESH_TOKEN_BYTES = 32;
/** 32 bytes in base64url, no padding. Used to reject malformed tokens before touching the database. */
export const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// A copy into a plain Uint8Array: Prisma's `Bytes` type wants an ArrayBuffer-backed array, which a Node Buffer isn't.
export function hashRefreshToken(token: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash('sha256').update(token).digest());
}

export function newRefreshToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

const DAY_MS = 86_400_000;

type SessionWriter = Pick<PrismaClient, 'refreshTokenFamily' | 'refreshToken'>;

export interface CreatedSession {
  familyId: string;
  refreshToken: string;
}

/**
 * Starts a new session: a family with its absolute lifetime and its first refresh token with an idle expiry.
 * Takes a transaction client so register can create the user, credential and session atomically.
 */
export async function createSession(
  db: SessionWriter,
  input: { userId: string; config: Pick<AuthConfig, 'refreshIdleDays' | 'sessionAbsoluteDays'>; now: Date },
): Promise<CreatedSession> {
  const absoluteExpiresAt = new Date(input.now.getTime() + input.config.sessionAbsoluteDays * DAY_MS);
  const idleExpiresAt = new Date(
    Math.min(input.now.getTime() + input.config.refreshIdleDays * DAY_MS, absoluteExpiresAt.getTime()),
  );
  const family = await db.refreshTokenFamily.create({
    data: { userId: input.userId, absoluteExpiresAt },
  });
  const { token, hash } = newRefreshToken();
  await db.refreshToken.create({ data: { familyId: family.id, tokenHash: hash, idleExpiresAt } });
  return { familyId: family.id, refreshToken: token };
}

/**
 * The session check, run on EVERY authenticated request (security.md): the token's family exists, belongs to
 * the token's user, is not revoked, and has not reached its absolute expiry. It reads shard A's PRIMARY, so a
 * logout or a detected theft stops the next request. The expiry comparison uses the database clock.
 */
export async function isSessionActive(
  db: Pick<PrismaClient, '$queryRaw'>,
  userId: string,
  familyId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok
    FROM refresh_token_families
    WHERE id = ${familyId}::uuid
      AND user_id = ${userId}::uuid
      AND revoked_at IS NULL
      AND absolute_expires_at > now()
  `;
  return rows.length === 1;
}
