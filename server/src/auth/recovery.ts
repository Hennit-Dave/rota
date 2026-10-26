import type { ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import type { AuthConfig } from './config.js';
import { renderRecoveryEmail, type RecoveryPurpose } from './recoveryEmail.js';
import { issueRecoverySecret, parseRecoverySecret } from './recoveryTokens.js';
import { authTransaction, createSession, revokeFamiliesOf, type CreatedSession } from './sessions.js';

/**
 * Password reset and magic link (ADR 0020, security.md). Both start the same way (an emailed single-use token, hashed in `auth_tokens`, with its
 * email work row in the same transaction on shard A, then enqueued) and end differently: a magic link signs the user in, a reset sets a new password
 * and ends every session. Redeeming either proves control of the address, so the account-verification policy applies to both.
 */
export interface RecoveryDeps {
  /** Frozen into every email, like the invitation emails. */
  mail: { from: string; replyTo: string };
  /** Enqueues an ALREADY COMMITTED work row (shard A). Never throws: a Valkey failure leaves the row eligible for the sweep (jobs.md). */
  enqueue: (prisma: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => Promise<void>;
}

// Same as invitations (ADR 0015): a row is first eligible for the timed sweep this long after it should have run.
const EMAIL_RUN_DELAY_MS = 2 * 60 * 1000;

const PATH: Record<RecoveryPurpose, string> = { magic_link: 'magic', password_reset: 'reset' };

/** Only what a request needs to know about an account. Never returned to the caller: the response is the same for every address. */
export async function findAccountByEmail(db: PrismaClient, email: string): Promise<{ id: string; email: string } | null> {
  return db.user.findUnique({ where: { email }, select: { id: true, email: true } });
}

/**
 * Issue a token for an existing account and queue its email. A newer request replaces any older unused token of the same purpose (the older link,
 * and its queued email, stop working). The token row and the work row commit together; only then is the job enqueued.
 */
export async function issueRecoveryEmail(
  db: PrismaClient,
  deps: RecoveryDeps,
  config: Pick<AuthConfig, 'magicLinkMinutes' | 'passwordResetMinutes' | 'transactionMaxWaitMs' | 'invites'>,
  input: { purpose: RecoveryPurpose; user: { id: string; email: string }; requestId: string | null },
): Promise<void> {
  const minutes = input.purpose === 'magic_link' ? config.magicLinkMinutes : config.passwordResetMinutes;
  const issued = issueRecoverySecret();
  const now = new Date();

  const work = await authTransaction(db, config, async (tx) => {
    await tx.$executeRaw`
      UPDATE auth_tokens SET used_at = NOW()
      WHERE user_id = ${input.user.id}::uuid AND purpose = ${input.purpose}::auth_token_purpose AND used_at IS NULL`;
    // The expiry is computed by the database, the same clock that checks it at redemption.
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
      VALUES (${input.user.id}::uuid, ${input.purpose}::auth_token_purpose, ${issued.tokenHash}, NOW() + (${minutes} || ' minutes')::interval)
      RETURNING id`;
    const tokenId = inserted[0]!.id;
    const payload = renderRecoveryEmail({
      from: deps.mail.from,
      replyTo: deps.mail.replyTo,
      to: input.user.email,
      purpose: input.purpose,
      link: `${config.invites.linkBaseUrl}/${PATH[input.purpose]}/${issued.secret}`,
      minutes,
      authTokenId: tokenId,
      tokenHashHex: issued.tokenHash.toString('hex'),
    });
    const row = await tx.workRow.create({
      data: {
        kind: 'email',
        payload: payload as unknown as object,
        originRequestId: input.requestId,
        runAt: now,
        availableAt: new Date(now.getTime() + EMAIL_RUN_DELAY_MS),
        status: 'pending',
        generation: 1,
        executionAttempts: 0,
      },
    });
    await tx.$executeRaw`UPDATE auth_tokens SET email_work_row_id = ${row.id}::uuid WHERE id = ${tokenId}::uuid`;
    return row;
  });

  await deps.enqueue(db, work, 'A');
}

export interface RedeemedMagicLink {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  session: CreatedSession;
}

interface LockedUser {
  id: string;
  email: string;
  name: string;
  email_verified_at: Date | null;
}

/**
 * Redeem a magic link: one transaction on shard A. The token is consumed by one conditional update (unused, right purpose, not expired), so two
 * simultaneous redemptions give one winner and everything else is "not available". An address that was UNVERIFIED is now proven, and whoever
 * registered it before may not own it: in the same transaction the existing password is cleared and every session is revoked, then the new session
 * is issued (security.md, account verification policy). A verified account loses nothing. Returns null for an unknown, used, replaced or expired
 * link, or one that is not shaped like ours.
 */
export async function redeemMagicLink(
  db: PrismaClient,
  config: Pick<AuthConfig, 'transactionMaxWaitMs' | 'refreshIdleDays' | 'sessionAbsoluteDays'>,
  input: { token: string; now: Date },
): Promise<RedeemedMagicLink | null> {
  const hash = parseRecoverySecret(input.token);
  if (!hash) return null;

  return authTransaction(db, config, async (tx) => {
    const consumed = await tx.$queryRaw<Array<{ user_id: string }>>`
      UPDATE auth_tokens SET used_at = NOW()
      WHERE token_hash = ${hash} AND purpose = 'magic_link'::auth_token_purpose AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id`;
    if (consumed.length === 0) return null;
    const userId = consumed[0]!.user_id;

    const users = await tx.$queryRaw<LockedUser[]>`
      SELECT id, email, name, email_verified_at FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const user = users[0];
    if (!user) return null;

    if (user.email_verified_at === null) {
      await tx.$executeRaw`UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = ${userId}::uuid`;
      await tx.$executeRaw`DELETE FROM credentials WHERE user_id = ${userId}::uuid`;
      await revokeFamiliesOf(tx, userId, 'address_verified');
    }
    const session = await createSession(tx, { userId, config, now: input.now });
    return { user: { id: user.id, email: user.email, name: user.name, emailVerified: true }, session };
  });
}

/**
 * Submit a password reset: one transaction on shard A. Consumes the token, sets the new password hash (creating the credential if a magic link had
 * cleared it), marks the address verified, revokes every session, and kills every other outstanding token of the user. It does NOT sign the user in:
 * they log in with the new password (OWASP, Forgot Password Cheat Sheet). The hash is made before the transaction, so no Argon2 run happens while the
 * rows are locked. Returns false for an unknown, used, replaced or expired link.
 */
export async function submitPasswordReset(
  db: PrismaClient,
  config: Pick<AuthConfig, 'transactionMaxWaitMs'>,
  input: { token: string; passwordHash: string },
): Promise<boolean> {
  const hash = parseRecoverySecret(input.token);
  if (!hash) return false;

  return authTransaction(db, config, async (tx) => {
    const consumed = await tx.$queryRaw<Array<{ user_id: string }>>`
      UPDATE auth_tokens SET used_at = NOW()
      WHERE token_hash = ${hash} AND purpose = 'password_reset'::auth_token_purpose AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id`;
    if (consumed.length === 0) return false;
    const userId = consumed[0]!.user_id;

    const users = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    if (users.length === 0) return false;

    await tx.$executeRaw`
      INSERT INTO credentials (user_id, password_hash) VALUES (${userId}::uuid, ${input.passwordHash})
      ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`;
    await tx.$executeRaw`
      UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = ${userId}::uuid`;
    await revokeFamiliesOf(tx, userId, 'password_reset');
    await tx.$executeRaw`UPDATE auth_tokens SET used_at = NOW() WHERE user_id = ${userId}::uuid AND used_at IS NULL`;
    return true;
  });
}
