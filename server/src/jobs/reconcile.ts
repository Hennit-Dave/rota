import type { Redis } from 'ioredis';
import type { Queue, JobState } from 'bullmq';
import type { Shards } from '../db/clients.js';
import type { ShardId } from '../db/shard.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  RECONCILE_BATCH_SIZE,
  RECONCILE_INTERVAL_MS,
  WORK_MAX_ATTEMPTS,
  WORK_MAX_RECOVERIES,
} from './config.js';
import { addWorkJob, formatJobId } from './queue.js';
import { sanitizeError } from './redact.js';

/**
 * Reconciliation sweep (jobs.md, "Recovery triggers"; ADR 0004).
 *
 * Postgres is the record; the Valkey queue can lose jobs. This sweep looks at work rows that should have
 * a live job and restores the ones that don't. It runs on a process-level timer in the worker,
 * independent of BullMQ, and also at worker startup and after a Valkey reconnect.
 *
 * Order of work for each shard (rule 9, Postgres first, then the queue):
 * 1. In a transaction, pick a batch with FOR UPDATE SKIP LOCKED. The lock protects only the pick.
 *    Expired-claim rows are recovered in that same transaction (bump generation / mark failed).
 * 2. After commit, look at the BullMQ job for each pending row and add, leave or replace it.
 * No session-level advisory locks: Neon's transaction-mode pooler does not support them.
 */

export type ReconcileTrigger = 'startup' | 'reconnect' | 'timed';

export type JobAction = 'add' | 'leave' | 'new_generation';

/**
 * What to do about a pending row, given the state of its current-generation BullMQ job.
 * - missing: add it with the remaining delay
 * - waiting / delayed / active: leave it
 * - failed / completed: re-adding the same ID does nothing, so the row needs a new generation
 */
export function decideJobAction(state: JobState | 'unknown'): JobAction {
  switch (state) {
    case 'unknown':
      return 'add';
    case 'failed':
    case 'completed':
      return 'new_generation';
    default:
      return 'leave';
  }
}

export interface ShardPassResult {
  shard: ShardId;
  /** Pending rows examined. */
  scanned: number;
  /** Pending rows whose job was missing and was added back. */
  restored: number;
  /** Pending rows whose job was waiting, delayed or active. */
  left: number;
  /** Expired-claim rows moved to a new generation (job added). */
  expiredRecovered: number;
  /** Expired-claim rows with no attempts left, marked failed. */
  exhausted: number;
  /** Pending rows whose BullMQ job had failed/completed: moved to a new generation (job added). */
  jobsRegenerated: number;
  /** Pending rows that hit the recovery cap and were marked failed (unclaimable_after_recoveries). */
  unclaimable: number;
  /** Valkey calls that failed. The first one ends this shard's pass; rows stay eligible. */
  valkeyErrors: number;
  /** Set when the shard's Postgres work failed. The other shard still runs. */
  postgresError?: string;
}

export interface ReconcileOptions {
  trigger: ReconcileTrigger;
  batchSize?: number;
  maxAttempts?: number;
  maxRecoveries?: number;
}

interface PickedRow {
  id: string;
  kind: string;
  generation: number;
  runAt: Date;
  executionAttempts: number;
  recoveryCount: number;
}

type RawPicked = {
  id: string;
  kind: string;
  generation: number | bigint;
  run_at: Date;
  execution_attempts: number | bigint;
  recovery_count: number | bigint;
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function toPicked(r: RawPicked): PickedRow {
  return {
    id: r.id,
    kind: r.kind,
    generation: Number(r.generation),
    runAt: new Date(r.run_at),
    executionAttempts: Number(r.execution_attempts),
    recoveryCount: Number(r.recovery_count),
  };
}

class ValkeyPassError extends Error {}

function emptyResult(shard: ShardId): ShardPassResult {
  return {
    shard,
    scanned: 0,
    restored: 0,
    left: 0,
    expiredRecovered: 0,
    exhausted: 0,
    jobsRegenerated: 0,
    unclaimable: 0,
    valkeyErrors: 0,
  };
}

/**
 * Step 1 for expired claims: `claimed` rows whose lease has run out.
 * Attempts left -> bump generation, clear the claim, back to pending (execution_attempts untouched).
 * No attempts left -> failed. Both conditional on the generation and expired lease we saw, so a racing
 * sweep or a late lease renewal makes the update change 0 rows instead of clobbering anything.
 * Returns the rows that now need a job added for their new generation.
 */
async function recoverExpiredClaims(
  prisma: PrismaClient,
  result: ShardPassResult,
  batchSize: number,
  maxAttempts: number,
  shard: ShardId,
  trigger: ReconcileTrigger,
): Promise<PickedRow[]> {
  const needJob: PickedRow[] = [];
  let cursor = NIL_UUID;

  for (;;) {
    const { page, bumped } = await prisma.$transaction(async (tx) => {
      const picked = (
        await tx.$queryRaw<RawPicked[]>`
          SELECT id, kind, generation, run_at, execution_attempts, recovery_count
          FROM work_rows
          WHERE status = 'claimed'::"work_status"
            AND claim_expires_at < NOW()
            AND id > ${cursor}::uuid
          ORDER BY id
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `
      ).map(toPicked);

      const bumpedRows: PickedRow[] = [];
      for (const row of picked) {
        if (row.executionAttempts >= maxAttempts) {
          const n = await tx.$executeRaw`
            UPDATE work_rows
            SET status = 'failed'::"work_status",
                failure_reason = 'attempt_budget_exhausted',
                updated_at = NOW()
            WHERE id = ${row.id}::uuid
              AND generation = ${row.generation}
              AND status = 'claimed'::"work_status"
              AND claim_expires_at < NOW()
          `;
          if (n > 0) {
            result.exhausted++;
            console.error(
              `[reconcile:row] trigger=${trigger} shard=${shard} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} action=mark_failed reason=attempt_budget_exhausted`,
            );
          }
          continue;
        }

        const updated = await tx.$queryRaw<RawPicked[]>`
          UPDATE work_rows
          SET status = 'pending'::"work_status",
              generation = generation + 1,
              claim_token = NULL,
              claim_expires_at = NULL,
              available_at = GREATEST(run_at, NOW()) + INTERVAL '2 minutes',
              updated_at = NOW()
          WHERE id = ${row.id}::uuid
            AND generation = ${row.generation}
            AND status = 'claimed'::"work_status"
            AND claim_expires_at < NOW()
          RETURNING id, kind, generation, run_at, execution_attempts, recovery_count
        `;
        if (updated[0]) {
          bumpedRows.push(toPicked(updated[0]));
        }
      }
      return { page: picked, bumped: bumpedRows };
    });

    needJob.push(...bumped);
    if (page.length < batchSize) break;
    cursor = page[page.length - 1]!.id;
  }

  return needJob;
}

/**
 * Add the job for a row whose current generation has no job (rule 9: the Postgres change is already
 * committed). On failure the row is made eligible for the next timed sweep and the pass for this shard
 * ends, because a Valkey that rejects one call will reject the rest.
 */
async function addJobOrMarkEligible(
  prisma: PrismaClient,
  queue: Queue,
  shard: ShardId,
  row: PickedRow,
  trigger: ReconcileTrigger,
  reason: string,
): Promise<number> {
  try {
    const { delayMs } = await addWorkJob(queue, row, shard);
    console.log(
      `[reconcile:row] trigger=${trigger} shard=${shard} job_id=${formatJobId(row.id, row.generation)} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} action=add reason=${reason} delay_ms=${delayMs}`,
    );
    return delayMs;
  } catch (err) {
    console.warn(
      `[reconcile:valkey_error] trigger=${trigger} shard=${shard} row_id=${row.id} generation=${row.generation} action=add: ${sanitizeError(err)}`,
    );
    // A failed Valkey write must never stop the row being recorded or retried (rule 13).
    await prisma.$executeRaw`
      UPDATE work_rows
      SET available_at = NOW(), updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND generation = ${row.generation}
        AND status = 'pending'::"work_status"
    `;
    throw new ValkeyPassError(sanitizeError(err));
  }
}

/** Longest BullMQ failure reason copied into failure_reason. Only bounds the text stored in the row. */
const MAX_FAILURE_REASON_CHARS = 500;

/**
 * A pending row whose BullMQ job is failed or completed (jobs.md, "Checking a pending row's job").
 * Re-adding the same ID does nothing, so the row needs a new generation.
 *
 * Attempts only count on a successful claim, so a job that fails BEFORE claiming (Postgres unreachable at
 * the claim, a bug in that path) would otherwise be resurrected on every sweep forever. recovery_count
 * bounds that (ADR 0004): each bump increments it in the same statement as the generation bump, a
 * successful claim resets it, and at the cap the row is marked failed for a human.
 * Both updates are conditional on the generation and pending status we saw, so racing sweeps are harmless.
 */
async function handleFinishedJob(
  prisma: PrismaClient,
  queue: Queue,
  result: ShardPassResult,
  shard: ShardId,
  row: PickedRow,
  state: JobState,
  trigger: ReconcileTrigger,
  maxRecoveries: number,
): Promise<void> {
  const jobId = formatJobId(row.id, row.generation);

  if (row.recoveryCount >= maxRecoveries) {
    let bullmqReason = `job_state=${state}`;
    try {
      const failedReason = (await queue.getJob(jobId))?.failedReason;
      if (failedReason) bullmqReason = sanitizeError(failedReason).slice(0, MAX_FAILURE_REASON_CHARS);
    } catch {
      // The reason is a courtesy; the row must still be failed even if Valkey cannot be asked.
    }
    const n = await prisma.$executeRaw`
      UPDATE work_rows
      SET status = 'failed'::"work_status",
          failure_reason = ${`unclaimable_after_recoveries: ${bullmqReason}`},
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND generation = ${row.generation}
        AND status = 'pending'::"work_status"
        AND recovery_count >= ${maxRecoveries}
    `;
    if (n > 0) {
      result.unclaimable++;
      console.error(
        `[reconcile:row] trigger=${trigger} shard=${shard} job_id=${jobId} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} recoveries=${row.recoveryCount} job_state=${state} action=mark_failed reason=unclaimable_after_recoveries`,
      );
    }
    return;
  }

  const bumped = await prisma.$queryRaw<RawPicked[]>`
    UPDATE work_rows
    SET generation = generation + 1,
        recovery_count = recovery_count + 1,
        available_at = GREATEST(run_at, NOW()) + INTERVAL '2 minutes',
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND generation = ${row.generation}
      AND status = 'pending'::"work_status"
    RETURNING id, kind, generation, run_at, execution_attempts, recovery_count
  `;
  if (!bumped[0]) return; // another sweep or a claim got there first
  const next = toPicked(bumped[0]);
  console.warn(
    `[reconcile:row] trigger=${trigger} shard=${shard} job_id=${jobId} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} job_state=${state} action=new_generation next_generation=${next.generation} recoveries=${next.recoveryCount}/${maxRecoveries}`,
  );
  result.jobsRegenerated++;
  await addJobOrMarkEligible(prisma, queue, shard, next, trigger, 'finished_job_new_generation');
}

/**
 * One reconciliation pass over one shard primary. Never throws: Postgres failures are reported in the
 * result (so the other shard still runs) and the first Valkey failure ends this shard's Valkey work.
 */
export async function reconcileShard(
  shard: ShardId,
  prisma: PrismaClient,
  queue: Queue,
  options: ReconcileOptions,
): Promise<ShardPassResult> {
  const batchSize = options.batchSize ?? RECONCILE_BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? WORK_MAX_ATTEMPTS;
  const maxRecoveries = options.maxRecoveries ?? WORK_MAX_RECOVERIES;
  const { trigger } = options;
  const result = emptyResult(shard);
  const handled = new Set<string>();

  try {
    // Expired claims first. Their rows are bumped to a new generation and need a new job.
    const bumped = await recoverExpiredClaims(prisma, result, batchSize, maxAttempts, shard, trigger);
    for (const row of bumped) {
      await addJobOrMarkEligible(prisma, queue, shard, row, trigger, 'expired_claim_new_generation');
      result.expiredRecovered++;
      handled.add(row.id);
    }

    // Pending rows. Startup and reconnect check every pending row; the timed sweep only those past
    // available_at (jobs.md, Recovery triggers).
    const checkAll = trigger !== 'timed';
    let cursor = NIL_UUID;
    for (;;) {
      const page = (
        await prisma.$transaction(async (tx) =>
          tx.$queryRaw<RawPicked[]>`
            SELECT id, kind, generation, run_at, execution_attempts, recovery_count
            FROM work_rows
            WHERE status = 'pending'::"work_status"
              AND id > ${cursor}::uuid
              AND (${checkAll}::boolean OR available_at <= NOW())
            ORDER BY id
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          `,
        )
      ).map(toPicked);

      // Lock released at commit. Valkey calls happen outside any transaction.
      for (const row of page) {
        if (handled.has(row.id)) continue;
        result.scanned++;

        let state: JobState | 'unknown';
        try {
          state = await queue.getJobState(formatJobId(row.id, row.generation));
        } catch (err) {
          console.warn(
            `[reconcile:valkey_error] trigger=${trigger} shard=${shard} row_id=${row.id} generation=${row.generation} action=lookup: ${sanitizeError(err)}`,
          );
          throw new ValkeyPassError(sanitizeError(err));
        }

        const action = decideJobAction(state);
        if (action === 'add') {
          await addJobOrMarkEligible(prisma, queue, shard, row, trigger, 'job_missing');
          result.restored++;
        } else if (action === 'leave') {
          result.left++;
          console.log(
            `[reconcile:row] trigger=${trigger} shard=${shard} job_id=${formatJobId(row.id, row.generation)} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} job_state=${state} action=leave`,
          );
        } else {
          await handleFinishedJob(prisma, queue, result, shard, row, state as JobState, trigger, maxRecoveries);
        }
      }

      if (page.length < batchSize) break;
      cursor = page[page.length - 1]!.id;
    }
  } catch (err) {
    if (err instanceof ValkeyPassError) {
      result.valkeyErrors++;
    } else {
      result.postgresError = sanitizeError(err);
      console.error(
        `[reconcile:postgres_error] trigger=${trigger} shard=${shard}: ${result.postgresError}`,
      );
    }
  }

  return result;
}

export interface ReconcileSummary {
  trigger: ReconcileTrigger;
  durationMs: number;
  shards: ShardPassResult[];
}

/**
 * One full pass over both shards. A failure on one shard is reported and does not stop the other.
 */
export async function reconcileOnce(
  shards: Shards,
  queue: Queue,
  options: ReconcileOptions,
): Promise<ReconcileSummary> {
  const started = performance.now();
  const results: ShardPassResult[] = [];
  for (const shard of ['A', 'B'] as const) {
    const r = await reconcileShard(shard, shards[shard].primary, queue, options);
    results.push(r);
    console.log(
      `[reconcile:shard] trigger=${options.trigger} shard=${shard} scanned=${r.scanned} restored=${r.restored} left=${r.left} expired_recovered=${r.expiredRecovered} exhausted=${r.exhausted} jobs_regenerated=${r.jobsRegenerated} unclaimable=${r.unclaimable} valkey_errors=${r.valkeyErrors}${r.postgresError ? ` postgres_error=${JSON.stringify(r.postgresError)}` : ''}`,
    );
  }
  return {
    trigger: options.trigger,
    durationMs: performance.now() - started,
    shards: results,
  };
}

export interface Reconciler {
  /** Run a pass now. If one is already running, a startup/reconnect request runs right after it. */
  run(trigger: ReconcileTrigger): Promise<void>;
  stop(): Promise<void>;
}

export interface SchedulerOptions {
  intervalMs?: number;
  /** A connection whose reconnection triggers a pass (ioredis emits 'close' then 'ready'). */
  reconnectSource?: Pick<Redis, 'on' | 'off'>;
}

/**
 * The process-level scheduler: a pass at startup, one on every interval, one after a Valkey reconnect.
 * Passes never overlap. A startup/reconnect request that arrives mid-pass is queued to run once more
 * straight after, because the running pass may have started before Valkey came back.
 * `runPass` never rejects (reconcileOnce reports failures in its result); this guards it anyway.
 */
export function createReconciler(
  runPass: (trigger: ReconcileTrigger) => Promise<unknown>,
  options?: SchedulerOptions,
): Reconciler {
  const intervalMs = options?.intervalMs ?? RECONCILE_INTERVAL_MS;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let queuedTrigger: ReconcileTrigger | null = null;

  async function run(trigger: ReconcileTrigger): Promise<void> {
    if (stopped) return;
    if (inFlight) {
      if (trigger !== 'timed') queuedTrigger = trigger;
      console.log(`[reconcile:skipped] trigger=${trigger} reason=pass_in_flight queued=${trigger !== 'timed'}`);
      return inFlight;
    }
    inFlight = (async () => {
      try {
        await runPass(trigger);
      } catch (err) {
        console.error(`[reconcile:error] trigger=${trigger}: ${sanitizeError(err)}`);
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    if (queuedTrigger && !stopped) {
      const next = queuedTrigger;
      queuedTrigger = null;
      await run(next);
    }
  }

  const timer = setInterval(() => void run('timed'), intervalMs);
  timer.unref?.();

  let wasDisconnected = false;
  const onClose = () => {
    wasDisconnected = true;
  };
  const onReady = () => {
    if (wasDisconnected) {
      wasDisconnected = false;
      void run('reconnect');
    }
  };
  options?.reconnectSource?.on('close', onClose);
  options?.reconnectSource?.on('ready', onReady);

  void run('startup');

  return {
    run,
    async stop() {
      stopped = true;
      clearInterval(timer);
      options?.reconnectSource?.off('close', onClose);
      options?.reconnectSource?.off('ready', onReady);
      queuedTrigger = null;
      await inFlight;
    },
  };
}

/** The worker's reconciler: both shards, one queue, scheduler around it. */
export function startReconciler(
  shards: Shards,
  queue: Queue,
  options?: SchedulerOptions & { batchSize?: number; maxAttempts?: number; maxRecoveries?: number },
): Reconciler {
  return createReconciler(
    (trigger) =>
      reconcileOnce(shards, queue, {
        trigger,
        batchSize: options?.batchSize,
        maxAttempts: options?.maxAttempts,
        maxRecoveries: options?.maxRecoveries,
      }),
    options,
  );
}
