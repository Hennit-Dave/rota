import { CANONICAL_UUID } from '../db/shard.js';
import type { JobHandler } from '../jobs/worker.js';
import type { Invalidator } from './store.js';

/**
 * A paid renewal can apply a scheduled reduction in the same transaction: the chosen people become inactive (`billing/renewal.ts`), which changes the roster. That
 * happens in the WORKER, so the worker has to replace the roster's generation too (caching.md).
 *
 * This wraps the `stripe_event` handler from OUTSIDE instead of changing it: the payment path (`billing/`) is not touched. After the handler has finished
 * without throwing, a successful renewal payment replaces the team's roster generation. It is more than strictly needed (a renewal with no reduction changes no
 * member) and costs one cache refill a month per team. If the handler throws, nothing is invalidated here: the job is retried and the retry that finishes does it.
 * The invalidation itself never throws and runs after the transaction committed, so it cannot block or undo recording a billing event (AGENTS.md rule 13).
 */
export function invalidateRosterAfterRenewalPayment(handler: JobHandler, cache: Invalidator): JobHandler {
  return async (ctx) => {
    await handler(ctx);
    const payload = ctx.row.payload as { purpose?: unknown; type?: unknown; teamId?: unknown } | null;
    if (payload?.purpose === 'renewal_payment' && payload.type === 'payment_intent.succeeded' && typeof payload.teamId === 'string' && CANONICAL_UUID.test(payload.teamId)) {
      await cache.invalidate(payload.teamId, ['roster']);
    }
  };
}
