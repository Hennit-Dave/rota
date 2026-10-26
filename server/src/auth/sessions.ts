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

type TransactionRunner = Pick<PrismaClient, '$transaction'>;
type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Every auth transaction goes through here so they all wait the configured time to START (config.transactionMaxWaitMs)
 * instead of Prisma's 2 s default, which a cold database connection can exceed.
 */
export function authTransaction<T>(
  db: TransactionRunner,
  config: Pick<AuthConfig, 'transactionMaxWaitMs'>,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(fn, { maxWait: config.transactionMaxWaitMs });
}

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

export type RefreshRejection =
  | 'unknown_token'
  | 'family_revoked'
  | 'family_expired'
  | 'idle_expired'
  | 'reuse_detected';

export type RefreshOutcome =
  | { kind: 'rotated'; userId: string; familyId: string; refreshToken: string }
  | { kind: 'rejected'; reason: RefreshRejection; userId?: string; familyId?: string };

interface LockedFamily {
  user_id: string;
  revoked: boolean;
  expired: boolean;
  absolute_expires_at: Date;
}

/**
 * Refresh-token rotation (security.md, "Refresh tokens and sessions"): ONE transaction.
 *
 *   1. find the presented token by its hash, OUTSIDE the transaction (a plain read; its family never changes), so
 *      a made-up token costs one cheap read and never opens a transaction
 *   2. lock the family row FOR UPDATE: every refresh, logout and logout-all of this session now queues here
 *   3. family revoked or past its absolute expiry -> rejected
 *   4. consume the token with ONE conditional update (unused, not idle-expired); that is what makes two
 *      simultaneous refreshes of one token produce exactly one winner
 *   5. update matched nothing and the token was already used -> REUSE: revoke the whole family
 *   6. insert the replacement token; commit
 *
 * The outcome is RETURNED, never thrown: throwing inside the transaction would roll back the family revocation
 * in step 5, and a detected theft would leave the thief's session alive. The caller turns a rejection into the
 * 401 only after this function has committed. Time comparisons use the database clock (like isSessionActive).
 */
export async function rotateRefreshToken(
  db: Pick<PrismaClient, '$transaction' | 'refreshToken'>,
  input: { token: string; config: Pick<AuthConfig, 'refreshIdleDays' | 'transactionMaxWaitMs'>; now: Date },
): Promise<RefreshOutcome> {
  const tokenHash = hashRefreshToken(input.token);
  const presented = await db.refreshToken.findUnique({ where: { tokenHash }, select: { id: true, familyId: true } });
  if (!presented) return { kind: 'rejected', reason: 'unknown_token' };

  return authTransaction(db, input.config, async (tx): Promise<RefreshOutcome> => {
    const [family] = await tx.$queryRaw<LockedFamily[]>`
      SELECT user_id,
             revoked_at IS NOT NULL AS revoked,
             absolute_expires_at <= now() AS expired,
             absolute_expires_at
      FROM refresh_token_families
      WHERE id = ${presented.familyId}::uuid
      FOR UPDATE
    `;
    // Deleted between step 1 and the lock (the user was removed).
    if (!family) return { kind: 'rejected', reason: 'unknown_token' };
    const ids = { userId: family.user_id, familyId: presented.familyId };
    if (family.revoked) return { kind: 'rejected', reason: 'family_revoked', ...ids };
    if (family.expired) return { kind: 'rejected', reason: 'family_expired', ...ids };

    const consumed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE refresh_tokens
      SET used_at = now()
      WHERE id = ${presented.id}::uuid
        AND family_id = ${presented.familyId}::uuid
        AND used_at IS NULL
        AND idle_expires_at > now()
      RETURNING id
    `;
    if (consumed.length === 0) {
      // Under the family lock the token row cannot change, so this read is the truth.
      const current = await tx.refreshToken.findUniqueOrThrow({ where: { id: presented.id }, select: { usedAt: true } });
      if (current.usedAt === null) return { kind: 'rejected', reason: 'idle_expired', ...ids };
      await tx.$executeRaw`
        UPDATE refresh_token_families
        SET revoked_at = now(), revoked_reason = 'reuse_detected'
        WHERE id = ${presented.familyId}::uuid AND revoked_at IS NULL
      `;
      return { kind: 'rejected', reason: 'reuse_detected', ...ids };
    }

    const next = newRefreshToken();
    const idleExpiresAt = new Date(
      Math.min(input.now.getTime() + input.config.refreshIdleDays * DAY_MS, family.absolute_expires_at.getTime()),
    );
    await tx.refreshToken.create({ data: { familyId: presented.familyId, tokenHash: next.hash, idleExpiresAt } });
    return { kind: 'rotated', ...ids, refreshToken: next.token };
  });
}

/**
 * Logout of one device: revokes one family under the same lock refresh takes. Idempotent: an already revoked
 * family is left as it was (its first reason is kept).
 */
export async function revokeFamily(
  db: TransactionRunner,
  input: { userId: string; familyId: string; config: Pick<AuthConfig, 'transactionMaxWaitMs'> },
): Promise<void> {
  await authTransaction(db, input.config, async (tx) => {
    await tx.$queryRaw`SELECT id FROM refresh_token_families WHERE id = ${input.familyId}::uuid FOR UPDATE`;
    await tx.$executeRaw`
      UPDATE refresh_token_families
      SET revoked_at = now(), revoked_reason = 'logout'
      WHERE id = ${input.familyId}::uuid AND user_id = ${input.userId}::uuid AND revoked_at IS NULL
    `;
  });
}

/**
 * Logout of every device: locks ALL of the user's families, in id order, then revokes the live ones. The fixed
 * order is what stops two of these (or one of these and a single-family lock) from deadlocking. Returns how many
 * families it revoked. A family created by a login that starts while this runs is not covered (ADR 0005).
 */
export async function revokeAllFamilies(
  db: TransactionRunner,
  input: { userId: string; config: Pick<AuthConfig, 'transactionMaxWaitMs'> },
): Promise<number> {
  return authTransaction(db, input.config, (tx) => revokeFamiliesOf(tx, input.userId, 'logout_all'));
}

/**
 * The locking and revoking of revokeAllFamilies, inside a transaction the caller already holds, with the reason it records. Password reset and
 * the account-verification rule for magic link (security.md) revoke every session in the same transaction that changes the account.
 */
export async function revokeFamiliesOf(tx: TransactionClient, userId: string, reason: string): Promise<number> {
  await tx.$queryRaw`SELECT id FROM refresh_token_families WHERE user_id = ${userId}::uuid ORDER BY id FOR UPDATE`;
  return tx.$executeRaw`
    UPDATE refresh_token_families
    SET revoked_at = now(), revoked_reason = ${reason}
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
  `;
}
