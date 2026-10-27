import { z } from 'zod';
import { CANONICAL_UUID } from '../db/shard.js';
import type { ActivityConfig } from './config.js';
import { decodeCursor, type Cursor } from './cursor.js';

/**
 * Request schemas for the feed (security.md: params, query, and a cursor that is decoded and then validated field by field). Strict objects: an unknown
 * query parameter is a 400. `limit` is a positive whole number up to the server's maximum (config); the cursor must be one the server could have made.
 */
export function createActivitySchemas(config: ActivityConfig) {
  const teamParams = z.strictObject({ teamId: z.string().regex(CANONICAL_UUID) });

  const list = z.strictObject({
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .transform(Number)
      .optional(),
    cursor: z.string().optional(),
  });

  /** The query after cross-field checks, with `limit` defaulted and the cursor decoded. */
  const query = list.transform((q, ctx): { limit: number; cursor: Cursor | null } => {
    let limit = config.pageDefault;
    if (q.limit !== undefined) {
      if (q.limit > config.pageMax) {
        ctx.addIssue({ code: 'custom', path: ['limit'], params: { rota: 'limit_too_large', max: config.pageMax } });
      } else {
        limit = q.limit;
      }
    }
    let cursor: Cursor | null = null;
    if (q.cursor !== undefined) {
      cursor = decodeCursor(q.cursor);
      if (!cursor) ctx.addIssue({ code: 'custom', path: ['cursor'], params: { rota: 'invalid_cursor' } });
    }
    return { limit, cursor };
  });

  return { teamParams, query };
}

export type ActivitySchemas = ReturnType<typeof createActivitySchemas>;
