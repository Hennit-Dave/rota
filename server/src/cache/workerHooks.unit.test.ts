import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JobContext } from '../jobs/worker.js';
import { invalidateRosterAfterRenewalPayment } from './workerHooks.js';

const TEAM = '00000000-0000-4000-8000-0000000000aa';
const ctxWith = (payload: unknown) => ({ row: { payload } }) as unknown as JobContext;

function setup(handler: (ctx: JobContext) => Promise<void> = async () => {}) {
  const calls: Array<{ teamId: string; kinds: readonly string[] }> = [];
  const wrapped = invalidateRosterAfterRenewalPayment(handler, { invalidate: async (teamId, kinds) => void calls.push({ teamId, kinds }) });
  return { wrapped, calls };
}

describe('the roster is invalidated after a renewal payment that the job finished (a reduction may have deactivated members)', () => {
  it('a successful renewal payment replaces the team roster generation, after the handler ran', async () => {
    const order: string[] = [];
    const calls: string[] = [];
    const wrapped = invalidateRosterAfterRenewalPayment(async () => void order.push('handler'), { invalidate: async () => void (order.push('invalidate'), calls.push('x')) });
    await wrapped(ctxWith({ purpose: 'renewal_payment', type: 'payment_intent.succeeded', teamId: TEAM }));
    assert.deepEqual(order, ['handler', 'invalidate']);
  });

  it('asks for the roster, and only the roster', async () => {
    const s = setup();
    await s.wrapped(ctxWith({ purpose: 'renewal_payment', type: 'payment_intent.succeeded', teamId: TEAM }));
    assert.deepEqual(s.calls, [{ teamId: TEAM, kinds: ['roster'] }]);
  });

  it('a failed payment, an activation payment, a card setup and a malformed payload invalidate nothing', async () => {
    const s = setup();
    await s.wrapped(ctxWith({ purpose: 'renewal_payment', type: 'payment_intent.payment_failed', teamId: TEAM }));
    await s.wrapped(ctxWith({ eventId: 'evt_1', teamId: TEAM }));
    await s.wrapped(ctxWith({ purpose: 'card_setup', teamId: TEAM }));
    await s.wrapped(ctxWith({ purpose: 'renewal_payment', type: 'payment_intent.succeeded', teamId: 'not-a-uuid' }));
    await s.wrapped(ctxWith(null));
    assert.deepEqual(s.calls, []);
  });

  it('a handler that throws is not wrapped over: its error passes through and nothing is invalidated (the retry that finishes does it)', async () => {
    const s = setup(async () => {
      throw new Error('boom');
    });
    await assert.rejects(s.wrapped(ctxWith({ purpose: 'renewal_payment', type: 'payment_intent.succeeded', teamId: TEAM })), /boom/);
    assert.deepEqual(s.calls, []);
  });
});
