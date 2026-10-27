import { z } from 'zod';
import { CANONICAL_UUID } from '../db/shard.js';

const uuid = z.string().regex(CANONICAL_UUID);

/** Request schemas for the swap routes (security.md: params, query and body, all strict). The idempotency key is a header, checked by `idempotencyKey`. */
export function createSwapSchemas() {
  const teamParams = z.strictObject({ teamId: uuid });
  const swapParams = z.strictObject({ teamId: uuid, swapId: uuid });
  /** The two shifts, by ID. WHO is giving and who receives is never sent: it is the caller and the assignee of the requested shift. */
  const create = z.strictObject({ offeredShiftId: uuid, requestedShiftId: uuid });
  return { teamParams, swapParams, create };
}

/** The `Idempotency-Key` header: a canonical lowercase UUID the app made for this one request. Null when absent or malformed. */
export function idempotencyKey(header: string | string[] | undefined): string | null {
  return typeof header === 'string' && CANONICAL_UUID.test(header) ? header : null;
}
