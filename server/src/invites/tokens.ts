import { createHash, randomBytes } from 'node:crypto';
import { CANONICAL_UUID } from '../db/shard.js';

/**
 * Invite tokens (ADR 0015). The link carries `<teamId>.<secret>`: the team ID is only a routing hint (it picks the shard, like every team
 * route), the secret is 32 random bytes in base64url. Only the SHA-256 of the SECRET is stored. Team and role always come from the invitation
 * row the secret matches, and the query is `WHERE team_id = ? AND token_hash = ?`, so a wrong team ID finds nothing.
 */
const SECRET_BYTES = 32;
// 32 bytes in unpadded base64url is exactly 43 characters.
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = new RegExp(`^(${CANONICAL_UUID.source.slice(1, -1)})\\.([A-Za-z0-9_-]{43})$`);

export interface IssuedInviteToken {
  /** What goes in the link: `<teamId>.<secret>`. Exists only in the link and the frozen email payload. */
  token: string;
  tokenHash: Buffer;
}

export function hashInviteSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function issueInviteToken(teamId: string): IssuedInviteToken {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { token: `${teamId}.${secret}`, tokenHash: hashInviteSecret(secret) };
}

/** Null for anything that is not exactly a canonical team ID, a dot, and a 43-character secret. The caller answers it like an unknown token. */
export function parseInviteToken(value: string): { teamId: string; secret: string; tokenHash: Buffer } | null {
  const match = TOKEN_PATTERN.exec(value);
  if (!match) return null;
  const [, teamId, secret] = match as unknown as [string, string, string];
  if (!SECRET_PATTERN.test(secret)) return null;
  return { teamId, secret, tokenHash: hashInviteSecret(secret) };
}
