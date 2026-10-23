import { z } from 'zod';
import type { AuthConfig } from '../auth/config.js';
import { CANONICAL_UUID } from '../db/shard.js';

/**
 * Request schemas for the invitation routes. Strict objects (unknown keys are errors). The role is limited to the two invitable roles:
 * `owner` is a validation error here and, if it ever got past, a CHECK constraint in the database (one Owner per team, ADR 0014).
 */
export function createInviteSchemas(config: Pick<AuthConfig, 'email'>) {
  const email = z.string().trim().toLowerCase().pipe(z.email().max(config.email.maxLength));
  return {
    teamParams: z.strictObject({ teamId: z.string().regex(CANONICAL_UUID) }),
    invitationParams: z.strictObject({ teamId: z.string().regex(CANONICAL_UUID), invitationId: z.string().regex(CANONICAL_UUID) }),
    create: z.strictObject({ email, role: z.enum(['manager', 'staff']) }),
    // A token that does not parse is answered like an unknown one (invite_unavailable), not as a validation error: only its size is bounded here.
    token: z.strictObject({ token: z.string().min(1).max(200) }),
  };
}
