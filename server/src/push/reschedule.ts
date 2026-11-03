import type { PrismaClient } from '../generated/prisma/client.js';
import { decide } from '../settings/quietHours.js';
import type { Settings } from '../settings/service.js';
import { pushPayload } from './message.js';

/**
 * A change to quiet hours or the time zone moves the user's waiting pushes (jobs.md "Rescheduled from outside", ADR 0024, ADR 0032). Called INSIDE the settings
 * change's transaction, so the new settings and the new schedule commit together. Only rows that are `pending` or `claimed` move; `done` and `failed` rows stay.
 *
 * For each such row: work out when it may be sent under the NEW settings, then in one statement set `run_at`, bump `generation`, clear any claim, reset
 * `available_at`. The caller enqueues the returned rows AFTER the commit, under the new job id. A running old execution fails its next ownership update and
 * aborts before its next external call (a `sent` delivery is never repeated, so it is harmless if it already sent).
 *
 * A pending row whose time would not change is left alone, so a change that does not matter does not churn the queue.
 */
export interface RescheduledRow {
  id: string;
  kind: 'push';
  generation: number;
  runAt: Date;
}

/** available_at = run_at + 2 minutes on normal creation (jobs.md). */
const SWEEP_GRACE_MS = 2 * 60 * 1000;

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export async function reschedulePushRows(tx: Tx, userId: string, settings: Settings, now: Date): Promise<RescheduledRow[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; generation: number; status: string; run_at: Date; payload: unknown }>>`
    SELECT id::text AS id, generation, status::text AS status, run_at, payload
    FROM work_rows
    WHERE kind = 'push' AND status IN ('pending'::work_status, 'claimed'::work_status) AND payload->>'userId' = ${userId}
    ORDER BY created_at, id
    FOR UPDATE`;

  const moved: RescheduledRow[] = [];
  for (const row of rows) {
    const payload = pushPayload.safeParse(row.payload);
    if (!payload.success) {
      console.warn(`[push:reschedule] row_id=${row.id} outcome=skipped reason=invalid_payload`);
      continue;
    }
    const decision = decide({
      quietHours: settings.quietHours.value,
      timeZone: settings.timeZone.value,
      fallbackTimeZone: payload.data.teamTimeZone,
      now,
      urgent: false,
    });
    const runAt = decision.send ? now : decision.delayUntil;
    const unchanged = row.status === 'pending' && (decision.send ? row.run_at.getTime() <= now.getTime() : Math.abs(row.run_at.getTime() - runAt.getTime()) < 1000);
    if (unchanged) continue;

    const updated = await tx.$queryRaw<Array<{ generation: number; run_at: Date }>>`
      UPDATE work_rows
      SET run_at = ${runAt}, available_at = ${new Date(runAt.getTime() + SWEEP_GRACE_MS)}, generation = generation + 1,
          status = 'pending'::work_status, claim_token = NULL, claim_expires_at = NULL, updated_at = now()
      WHERE id = ${row.id}::uuid AND generation = ${row.generation} AND status IN ('pending'::work_status, 'claimed'::work_status)
      RETURNING generation, run_at`;
    const u = updated[0];
    if (!u) {
      console.warn(`[push:reschedule] row_id=${row.id} outcome=no_change reason=row_moved_on`);
      continue;
    }
    moved.push({ id: row.id, kind: 'push', generation: Number(u.generation), runAt: u.run_at });
    console.log(`[push:reschedule] row_id=${row.id} generation=${u.generation} outcome=rescheduled run_at=${u.run_at.toISOString()}`);
  }
  return moved;
}
