import { createHash, randomBytes } from 'node:crypto';

/**
 * Magic-link and password-reset tokens (ADR 0020). The link carries the secret alone: 32 random bytes in base64url (43 characters). Only its SHA-256
 * is stored, in `auth_tokens`. Unlike an invite there is no team to route by: the token row names the user and the purpose, and redemption looks
 * the hash up on shard A.
 */
const SECRET_BYTES = 32;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashRecoverySecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function issueRecoverySecret(): { secret: string; tokenHash: Buffer } {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { secret, tokenHash: hashRecoverySecret(secret) };
}

/** The hash for a token exactly as we issue it, or null for anything else. The caller answers null like an unknown token. */
export function parseRecoverySecret(value: string): Buffer | null {
  return SECRET_PATTERN.test(value) ? hashRecoverySecret(value) : null;
}
