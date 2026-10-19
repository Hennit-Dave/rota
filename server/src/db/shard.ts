import { createHash } from 'node:crypto';

export type ShardId = 'A' | 'B';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Shard function (data.md): SHA-256 of the UTF-8 team_id string, first 4 bytes read as an unsigned
 * big-endian integer, mod 2. 0 -> A, 1 -> B. Never change without an ADR and a migration plan.
 */
export function shardIntegerFor(teamId: string): number {
  if (!CANONICAL_UUID.test(teamId)) {
    throw new Error('team_id must be a canonical lowercase hyphenated UUID');
  }
  const digest = createHash('sha256').update(teamId, 'utf8').digest();
  return digest.readUInt32BE(0);
}

export function shardFor(teamId: string): ShardId {
  return shardIntegerFor(teamId) % 2 === 0 ? 'A' : 'B';
}
