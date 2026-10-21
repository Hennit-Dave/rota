import type { PrismaClient } from '../generated/prisma/client.js';
import type { Shards } from './clients.js';

/**
 * Identity tables (users, credentials, refresh-token records) live on shard A (data.md). Every identity
 * read uses the PRIMARY: session checks and refresh-token checks must see revocations immediately, so they
 * are "primary-required" reads. This is the only accessor for them; nothing else reaches into a shard's
 * client directly. When the read-routing function lands (build step 5), this is the call it replaces.
 */
export function identityDb(shards: Shards): PrismaClient {
  return shards.A.primary;
}
