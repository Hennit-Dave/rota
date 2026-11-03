import { insertWorkRow, type NewWork } from '../billing/renewalNotice.js';
import type { EnqueueRow } from '../billing/renewal.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { shardFor } from '../db/shard.js';
import { shiftEventRecipients, swapDecidedRecipients, swapRequestedRecipients } from './recipients.js';
import type { PushEventPayload } from './message.js';

/**
 * Writing the `push_event` work row for a shift or swap event (ADR 0033). It is written INSIDE the same transaction as the activity row, on the team's shard
 * (jobs.md: Postgres first, then the queue): if the change rolls back, so does the push; if it commits, the push is never forgotten, even if Valkey is down (the
 * sweep re-adds it). The caller enqueues the returned rows AFTER the commit (`enqueueEvents`). Everything after this (who is still a member, their switches,
 * quiet hours, the devices) is decided by the part 1 jobs, when they run.
 *
 * The words are generic on purpose (Dave, 2026-11-03): a notification can be read on a locked phone, so there is no shift title, time or person in it. The
 * moment and the ids are in the `data`, which only the app reads.
 */
type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export const PUSH_TEXT = {
  shift_created: { title: 'You have a new shift', body: 'Open Rota to see your schedule.' },
  shift_updated: { title: 'Your shift changed', body: 'Open Rota to see what changed.' },
  shift_deleted: { title: 'A shift was removed', body: 'Open Rota to see your schedule.' },
  swap_requested_approver: { title: 'A swap needs your approval', body: 'Open Rota to review it.' },
  swap_requested_counterparty: { title: 'A teammate asked to swap shifts with you', body: 'Open Rota to see the request.' },
  swap_approved: { title: 'Your swap was approved', body: 'Your shifts have changed. Open Rota to see them.' },
  swap_rejected: { title: 'Your swap was declined', body: 'Open Rota to see the request.' },
} as const;

async function write(tx: Tx, event: PushEventPayload, now: Date): Promise<NewWork[]> {
  if (event.recipients.length === 0) return [];
  return [await insertWorkRow(tx, 'push_event', event, now)];
}

export async function queueShiftEvent(
  tx: Tx,
  input: { teamId: string; moment: 'shift_created' | 'shift_updated' | 'shift_deleted'; shiftId: string; actorUserId: string; assignedUserId: string | null; previousAssignedUserId?: string | null },
  now = new Date(),
): Promise<NewWork[]> {
  const recipients = shiftEventRecipients(input);
  return write(tx, { moment: input.moment, teamId: input.teamId, recipients, shiftId: input.shiftId, ...PUSH_TEXT[input.moment] }, now);
}

export async function queueSwapRequested(
  tx: Tx,
  input: { teamId: string; swapId: string; actorUserId: string; counterpartyUserId: string; approverIds: string[] },
  now = new Date(),
): Promise<NewWork[]> {
  const { approvers, counterparty } = swapRequestedRecipients(input);
  const base = { moment: 'swap_requested' as const, teamId: input.teamId, swapId: input.swapId };
  return [
    ...(await write(tx, { ...base, recipients: approvers, ...PUSH_TEXT.swap_requested_approver }, now)),
    ...(await write(tx, { ...base, recipients: counterparty, ...PUSH_TEXT.swap_requested_counterparty }, now)),
  ];
}

export async function queueSwapDecided(
  tx: Tx,
  input: { teamId: string; swapId: string; moment: 'swap_approved' | 'swap_rejected'; actorUserId: string; requesterUserId: string; counterpartyUserId: string },
  now = new Date(),
): Promise<NewWork[]> {
  return write(tx, { moment: input.moment, teamId: input.teamId, swapId: input.swapId, recipients: swapDecidedRecipients(input), ...PUSH_TEXT[input.moment] }, now);
}

/** After the transaction committed. `enqueue` never throws (a Valkey failure leaves the row for the sweep); without one (a test that builds the services alone) the rows simply wait for it. */
export async function enqueueEvents(prisma: PrismaClient, teamId: string, rows: NewWork[], enqueue?: EnqueueRow): Promise<void> {
  if (!enqueue) return;
  for (const row of rows) await enqueue(prisma, row, shardFor(teamId));
}
