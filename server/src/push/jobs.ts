import { getShard, type Shards } from '../db/clients.js';
import type { EnqueueRow } from '../billing/renewal.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { TerminalJobError, type JobContext, type JobHandler } from '../jobs/worker.js';
import { decide } from '../settings/quietHours.js';
import { getSettings } from '../settings/service.js';
import { deleteDeviceById, devicesOf } from './devices.js';
import { ExpoPushError, MAX_MESSAGES_PER_REQUEST, MAX_RECEIPTS_PER_REQUEST, type ExpoMessage, type ExpoPushClient } from './expo.js';
import type { PushConfig } from './config.js';
import {
  ESSENTIAL_MOMENTS,
  MOMENT_TYPE,
  pushDataFor,
  pushEventPayload,
  pushPayload,
  pushReceiptsPayload,
  type PushPayload,
} from './message.js';

/**
 * The three push jobs (ADR 0032, jobs.md "Push"). Every row is a work row: Postgres first, the queue second.
 *
 *   push_event     (the TEAM shard, written in the same transaction as the event)  fan-out: one `push` row per recipient on shard A. Users, their device tokens
 *                  and their settings live on shard A, the event on the team's shard, so one transaction cannot hold both; this job is the bridge, and the unique
 *                  key on (event, user) makes a replay harmless.
 *   push           (shard A)  one per (event, recipient). Re-reads everything that decides whether and when to send, WHEN IT RUNS: the recipient's role in the team,
 *                  their type toggle, their quiet hours and time zone. Then one call to Expo for all their devices.
 *   push_receipts  (shard A)  about 15 minutes after a send: asks Expo what happened to each ticket; DeviceNotRegistered deletes the token.
 *
 * At-least-once, not exactly-once: an accepted ticket does not prove the phone has it, and a crash between the call and the record can send twice.
 */
export const PUSH_EVENT_KIND = 'push_event';
export const PUSH_KIND = 'push';
export const PUSH_RECEIPTS_KIND = 'push_receipts';

/** available_at = run_at + 2 minutes on normal creation (jobs.md). */
const SWEEP_GRACE_MS = 2 * 60 * 1000;
/** Expo clears receipts after 24 hours; give up a little before that. */
const RECEIPT_WINDOW_MS = 23 * 60 * 60 * 1000;

interface Deps {
  shards: Shards;
  enqueue: EnqueueRow;
}

class OwnershipLostError extends Error {
  constructor(where: string) {
    super(`work row ownership lost ${where}`);
    this.name = 'OwnershipLostError';
  }
}

const logBaseOf = (kind: string, ctx: JobContext) => `[${kind}] row_id=${ctx.row.id} generation=${ctx.row.generation} origin_request_id=${ctx.row.originRequestId ?? '-'}`;

/**
 * Hands the row it is running back to the queue for a later time (jobs.md "Rescheduled from outside", used here by the job itself): one statement sets `run_at`,
 * bumps the generation and clears the claim. The processor's own "done" update then matches nothing (it logs lost_ownership; that is expected). Returns the new
 * generation, for the caller to enqueue; null if the claim was already lost.
 */
async function deferThisRow(ctx: JobContext, runAt: Date): Promise<{ generation: number; runAt: Date } | null> {
  const rows = await ctx.prisma.$queryRaw<Array<{ generation: number; run_at: Date }>>`
    UPDATE work_rows
    SET run_at = ${runAt}, available_at = ${new Date(runAt.getTime() + SWEEP_GRACE_MS)}, generation = generation + 1,
        status = 'pending'::work_status, claim_token = NULL, claim_expires_at = NULL, updated_at = now()
    WHERE id = ${ctx.row.id}::uuid AND generation = ${ctx.row.generation} AND claim_token = ${ctx.claimToken}::uuid AND status = 'claimed'::work_status
    RETURNING generation, run_at`;
  const r = rows[0];
  return r ? { generation: Number(r.generation), runAt: r.run_at } : null;
}

async function renewalIsPaid(prisma: PrismaClient, renewalId: string): Promise<boolean> {
  const unpaid = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok FROM renewals WHERE id = ${renewalId}::uuid AND status <> 'paid'::renewal_status`;
  return unpaid.length === 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// push_event: fan out to one `push` row per recipient
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

export function createPushEventHandler(deps: Deps): JobHandler {
  return async (ctx) => {
    const logBase = logBaseOf('push_event', ctx);
    const parsed = pushEventPayload.safeParse(ctx.row.payload);
    if (!parsed.success) throw new TerminalJobError('invalid_payload');
    const event = parsed.data;

    const team = await ctx.prisma.$queryRaw<Array<{ time_zone: string }>>`SELECT time_zone FROM teams WHERE id = ${event.teamId}::uuid`;
    if (team.length === 0) {
      console.log(`${logBase} outcome=skipped reason=team_not_found`);
      return;
    }
    // The read-only notice is made at the failure but runs at the end of the grace period; if the renewal was paid in between it would be wrong.
    if (event.renewalId && event.skipIfRenewalPaid && (await renewalIsPaid(ctx.prisma, event.renewalId))) {
      console.log(`${logBase} outcome=skipped reason=renewal_paid`);
      return;
    }

    const identity = deps.shards.A.primary;
    const now = new Date();
    let made = 0;
    for (const userId of event.recipients) {
      const settings = await getSettings(identity, userId);
      const decision = decide({ quietHours: settings.quietHours.value, timeZone: settings.timeZone.value, fallbackTimeZone: team[0]!.time_zone, now, urgent: false });
      const runAt = decision.send ? now : decision.delayUntil;
      const payload: PushPayload = {
        dedupeKey: `${ctx.row.id}:${userId}`,
        eventRowId: ctx.row.id,
        userId,
        teamId: event.teamId,
        teamTimeZone: team[0]!.time_zone,
        moment: event.moment,
        title: event.title,
        body: event.body,
        ...(event.renewalId ? { renewalId: event.renewalId } : {}),
        ...(event.skipIfRenewalPaid ? { skipIfRenewalPaid: true } : {}),
      };
      // ON CONFLICT DO NOTHING: a replay of this fan-out finds the row already there. If the first run crashed before enqueueing, the sweep picks the pending row up.
      const inserted = await identity.$queryRaw<Array<{ id: string; generation: number; run_at: Date }>>`
        INSERT INTO work_rows (kind, payload, run_at, available_at, status, generation, execution_attempts, origin_request_id)
        VALUES ('push', ${JSON.stringify(payload)}::jsonb, ${runAt}, ${new Date(runAt.getTime() + SWEEP_GRACE_MS)}, 'pending'::work_status, 1, 0, ${ctx.row.originRequestId}::uuid)
        ON CONFLICT ((payload->>'dedupeKey')) WHERE kind = 'push' DO NOTHING
        RETURNING id::text AS id, generation, run_at`;
      const row = inserted[0];
      if (!row) continue;
      made += 1;
      await deps.enqueue(identity, { id: row.id, kind: PUSH_KIND, generation: Number(row.generation), runAt: row.run_at }, 'A');
    }
    console.log(`${logBase} outcome=fanned_out recipients=${event.recipients.length} created=${made}`);
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// push: decide, then send to the recipient's devices
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PushSendDeps extends Deps {
  expo: ExpoPushClient;
  config: PushConfig;
  now?: () => Date;
}

/** Is this recipient still the right person to tell, and does the thing still need telling? Reads the TEAM shard primary: roles are never cached (security.md). */
async function stillWanted(deps: Deps, payload: PushPayload): Promise<{ ok: true } | { ok: false; reason: string }> {
  const team = getShard(deps.shards, payload.teamId).primary;
  // Billing goes to the Owner of the team and nobody else (issue #53): an Owner who is no longer one, or was deactivated, gets nothing.
  if (MOMENT_TYPE[payload.moment] === 'billing') {
    const owner = await team.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM memberships
      WHERE team_id = ${payload.teamId}::uuid AND user_id = ${payload.userId}::uuid AND role = 'owner'::team_role AND deactivated_at IS NULL`;
    if (owner.length === 0) return { ok: false, reason: 'not_owner' };
  }
  if (payload.renewalId && (await renewalIsPaid(team, payload.renewalId))) return { ok: false, reason: 'renewal_paid' };
  return { ok: true };
}

export function createPushHandler(deps: PushSendDeps): JobHandler {
  const clock = deps.now ?? (() => new Date());
  return async (ctx) => {
    const { prisma, row } = ctx;
    const logBase = logBaseOf('push', ctx);
    const parsed = pushPayload.safeParse(row.payload);
    if (!parsed.success) throw new TerminalJobError('invalid_payload');
    const payload = parsed.data;

    // 1. Role and "is it still true", read now.
    const wanted = await stillWanted(deps, payload);
    if (!wanted.ok) {
      console.log(`${logBase} outcome=skipped reason=${wanted.reason}`);
      return;
    }

    // 2. The recipient's settings, read now. The type toggle, unless the moment is essential (Dave, 2026-11-03: failed-renewal pushes skip the toggle only).
    const settings = await getSettings(prisma, payload.userId);
    const type = MOMENT_TYPE[payload.moment];
    const toggleOn = type === 'shift_changes' ? settings.notifyShiftChanges.value : type === 'swap_updates' ? settings.notifySwapUpdates.value : settings.notifyBilling.value;
    if (!toggleOn && !ESSENTIAL_MOMENTS.has(payload.moment)) {
      console.log(`${logBase} outcome=skipped reason=type_off type=${type}`);
      return;
    }

    // 3. Quiet hours, in the user's time zone (the team's when they have none), decided now. Quiet hours apply to every push, essential ones too.
    const now = clock();
    const decision = decide({ quietHours: settings.quietHours.value, timeZone: settings.timeZone.value, fallbackTimeZone: payload.teamTimeZone, now, urgent: false });
    if (!decision.send) {
      const deferred = await deferThisRow(ctx, decision.delayUntil);
      if (!deferred) throw new OwnershipLostError('before deferring for quiet hours');
      await deps.enqueue(prisma, { id: row.id, kind: PUSH_KIND, generation: deferred.generation, runAt: deferred.runAt }, 'A');
      console.log(`${logBase} outcome=deferred reason=quiet_hours run_at=${deferred.runAt.toISOString()}`);
      return;
    }

    // 4. The devices. None is not an error: the person may not have the app on a phone yet.
    const devices = await devicesOf(prisma, payload.userId);
    if (devices.length === 0) {
      console.log(`${logBase} outcome=skipped reason=no_devices`);
      return;
    }

    // A `sending` delivery that exists before this execution wrote anything belongs to an earlier execution that stopped between "about to call Expo" and "recorded
    // the answer": its outcome is unknown, so it is sent again and logged (jobs.md: possible duplicate).
    const earlier = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM push_deliveries WHERE work_row_id = ${row.id}::uuid AND status = 'sending'::push_delivery_status`;
    if ((earlier[0]?.n ?? 0) > 0) console.warn(`${logBase} outcome=possible_duplicate deliveries=${earlier[0]!.n} reason=earlier_execution_did_not_record_the_answer`);

    for (const device of devices) {
      await prisma.$executeRaw`
        INSERT INTO push_deliveries (work_row_id, device_token_id) VALUES (${row.id}::uuid, ${device.id}::uuid)
        ON CONFLICT (work_row_id, device_token_id) DO NOTHING`;
    }
    const todo = await prisma.$queryRaw<Array<{ delivery_id: string; device_id: string; expo_token: string }>>`
      SELECT d.id::text AS delivery_id, d.device_token_id::text AS device_id, t.expo_token
      FROM push_deliveries d JOIN device_tokens t ON t.id = d.device_token_id
      WHERE d.work_row_id = ${row.id}::uuid AND d.status = 'sending'::push_delivery_status
      ORDER BY d.created_at, d.id`;
    if (todo.length === 0) {
      console.log(`${logBase} outcome=already_sent`);
      return;
    }
    await prisma.$executeRaw`UPDATE push_deliveries SET sending_started_at = now() WHERE work_row_id = ${row.id}::uuid AND status = 'sending'::push_delivery_status`;

    // 5. The send, in batches. The lease is renewed right before each call; ownership lost = abort (jobs.md).
    let accepted = 0;
    for (let i = 0; i < todo.length; i += MAX_MESSAGES_PER_REQUEST) {
      const batch = todo.slice(i, i + MAX_MESSAGES_PER_REQUEST);
      if (!(await ctx.renewLease())) throw new OwnershipLostError('before the send');
      const messages: ExpoMessage[] = batch.map((d) => ({ to: d.expo_token, title: payload.title, body: payload.body, data: pushDataFor(payload), channelId: 'default' }));
      let tickets;
      try {
        tickets = await deps.expo.send(messages);
      } catch (err) {
        if (err instanceof ExpoPushError) {
          console.warn(`${logBase} outcome=${err.kind}_failure reason=${err.reason}${err.status === undefined ? '' : ` http=${err.status}`}`);
          if (err.kind === 'terminal') {
            for (const d of batch) {
              await prisma.$executeRaw`UPDATE push_deliveries SET status = 'failed'::push_delivery_status, error = ${err.reason} WHERE id = ${d.delivery_id}::uuid AND status = 'sending'::push_delivery_status`;
            }
            throw new TerminalJobError(err.reason);
          }
        }
        throw err; // retryable: the deliveries stay `sending`, the processor releases the claim and BullMQ retries with backoff
      }
      // Recording an answer is a fact about Expo, true whoever now owns the row, so it is not ownership-matched.
      for (let j = 0; j < batch.length; j++) {
        const d = batch[j]!;
        const ticket = tickets[j]!;
        if (ticket.status === 'ok') {
          accepted += 1;
          await prisma.$executeRaw`
            UPDATE push_deliveries SET status = 'sent'::push_delivery_status, ticket_id = ${ticket.id}, sent_at = now()
            WHERE id = ${d.delivery_id}::uuid AND status = 'sending'::push_delivery_status`;
        } else if (ticket.error === 'DeviceNotRegistered') {
          // Expo says this device cannot receive push any more: stop sending to it. Deleting the token deletes its delivery record with it.
          console.log(`${logBase} outcome=device_removed reason=DeviceNotRegistered device_id=${d.device_id}`);
          await deleteDeviceById(prisma, d.device_id);
        } else {
          await prisma.$executeRaw`
            UPDATE push_deliveries SET status = 'failed'::push_delivery_status, error = ${ticket.error ?? 'rejected'}
            WHERE id = ${d.delivery_id}::uuid AND status = 'sending'::push_delivery_status`;
          console.warn(`${logBase} outcome=ticket_error reason=${ticket.error ?? 'rejected'} device_id=${d.device_id}`);
        }
      }
    }

    // 6. Receipts later. One receipts row per push row (made only if none exists), after the sends are recorded.
    if (accepted > 0) {
      const runAt = new Date(clock().getTime() + deps.config.receiptDelayMs);
      const made = await prisma.$queryRaw<Array<{ id: string; generation: number; run_at: Date }>>`
        INSERT INTO work_rows (kind, payload, run_at, available_at, status, generation, execution_attempts, origin_request_id)
        SELECT 'push_receipts', ${JSON.stringify({ pushRowId: row.id })}::jsonb, ${runAt}, ${new Date(runAt.getTime() + SWEEP_GRACE_MS)}, 'pending'::work_status, 1, 0, ${row.originRequestId}::uuid
        WHERE NOT EXISTS (SELECT 1 FROM work_rows WHERE kind = 'push_receipts' AND payload->>'pushRowId' = ${row.id})
        RETURNING id::text AS id, generation, run_at`;
      if (made[0]) await deps.enqueue(prisma, { id: made[0].id, kind: PUSH_RECEIPTS_KIND, generation: Number(made[0].generation), runAt: made[0].run_at }, 'A');
    }
    console.log(`${logBase} outcome=sent devices=${todo.length} accepted=${accepted}`);
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// push_receipts: what happened to the tickets
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

export function createPushReceiptsHandler(deps: { expo: ExpoPushClient; config: PushConfig; enqueue: EnqueueRow; now?: () => Date }): JobHandler {
  const clock = deps.now ?? (() => new Date());
  return async (ctx) => {
    const { prisma, row } = ctx;
    const logBase = logBaseOf('push_receipts', ctx);
    const parsed = pushReceiptsPayload.safeParse(row.payload);
    if (!parsed.success) throw new TerminalJobError('invalid_payload');

    const waiting = await prisma.$queryRaw<Array<{ delivery_id: string; device_id: string; ticket_id: string; sent_at: Date }>>`
      SELECT id::text AS delivery_id, device_token_id::text AS device_id, ticket_id, sent_at
      FROM push_deliveries
      WHERE work_row_id = ${parsed.data.pushRowId}::uuid AND status = 'sent'::push_delivery_status AND receipt_checked_at IS NULL
      ORDER BY created_at, id`;
    if (waiting.length === 0) {
      console.log(`${logBase} outcome=nothing_to_check`);
      return;
    }

    const receipts: Awaited<ReturnType<ExpoPushClient['getReceipts']>> = {};
    for (let i = 0; i < waiting.length; i += MAX_RECEIPTS_PER_REQUEST) {
      if (!(await ctx.renewLease())) throw new OwnershipLostError('before the receipts call');
      try {
        Object.assign(receipts, await deps.expo.getReceipts(waiting.slice(i, i + MAX_RECEIPTS_PER_REQUEST).map((w) => w.ticket_id)));
      } catch (err) {
        if (err instanceof ExpoPushError) {
          console.warn(`${logBase} outcome=${err.kind}_failure reason=${err.reason}${err.status === undefined ? '' : ` http=${err.status}`}`);
          if (err.kind === 'terminal') throw new TerminalJobError(err.reason);
        }
        throw err;
      }
    }

    const now = clock();
    let stillWaiting = 0;
    for (const w of waiting) {
      const r = receipts[w.ticket_id];
      if (!r) {
        if (now.getTime() - w.sent_at.getTime() >= RECEIPT_WINDOW_MS) {
          await prisma.$executeRaw`UPDATE push_deliveries SET receipt_checked_at = now(), error = 'receipt_missing' WHERE id = ${w.delivery_id}::uuid`;
        } else stillWaiting += 1;
        continue;
      }
      if (r.status === 'ok') {
        await prisma.$executeRaw`UPDATE push_deliveries SET receipt_checked_at = now() WHERE id = ${w.delivery_id}::uuid`;
      } else if (r.error === 'DeviceNotRegistered') {
        console.log(`${logBase} outcome=device_removed reason=DeviceNotRegistered device_id=${w.device_id}`);
        await deleteDeviceById(prisma, w.device_id);
      } else {
        await prisma.$executeRaw`UPDATE push_deliveries SET receipt_checked_at = now(), error = ${r.error ?? 'error'} WHERE id = ${w.delivery_id}::uuid`;
        console.warn(`${logBase} outcome=receipt_error reason=${r.error ?? 'error'} device_id=${w.device_id}`);
      }
    }

    // A receipt Expo does not have yet: look again later, from the same row (a new generation), until Expo's own 24-hour clearing.
    if (stillWaiting > 0) {
      const deferred = await deferThisRow(ctx, new Date(now.getTime() + deps.config.receiptDelayMs));
      if (!deferred) throw new OwnershipLostError('before deferring the receipts check');
      await deps.enqueue(prisma, { id: row.id, kind: PUSH_RECEIPTS_KIND, generation: deferred.generation, runAt: deferred.runAt }, 'A');
      console.log(`${logBase} outcome=deferred reason=receipts_not_ready waiting=${stillWaiting}`);
      return;
    }
    console.log(`${logBase} outcome=checked receipts=${waiting.length}`);
  };
}
