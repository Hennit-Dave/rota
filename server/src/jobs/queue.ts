import { Queue, type JobsOptions } from 'bullmq';
import type { ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import {
  BULLMQ_JOB_ATTEMPTS,
  PRODUCER_ENQUEUE_TIMEOUT_MS,
  WORK_BACKOFF_DELAY_MS,
} from './config.js';
import { createProducerConnection } from './connection.js';

import { sanitizeError } from './redact.js';

export const WORK_QUEUE_NAME = 'work';

/**
 * Resolves the queue name for producer and worker.
 * Uses custom name if provided, otherwise WORK_QUEUE_NAME env var, otherwise default 'work'.
 */
export function resolveQueueName(customName?: string): string {
  return customName || process.env.WORK_QUEUE_NAME || WORK_QUEUE_NAME;
}

export interface EnqueueOptions {
  payload?: any;
  runAt?: Date;
  queue?: Queue;
  queueName?: string;
  shard: ShardId;
}

let sharedProducerConnection: ReturnType<typeof createProducerConnection> | null = null;
let sharedProducerQueue: Queue | null = null;

export function createWorkQueue(
  queueName = resolveQueueName(),
  connection = createProducerConnection(),
): Queue {
  const resolved = resolveQueueName(queueName);
  return new Queue(resolved, {
    connection,
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}

/**
 * Get or create the shared producer queue singleton.
 * Reuses a single producer queue and connection across requests for the same queue name.
 * Rejects mismatched queue names to prevent silent cross-queue routing.
 */
export function getProducerQueue(
  queueName?: string,
  connection?: ReturnType<typeof createProducerConnection>,
): Queue {
  const targetName = resolveQueueName(queueName);
  if (sharedProducerQueue) {
    if (sharedProducerQueue.name !== targetName) {
      throw new Error(
        `Cannot get producer queue '${targetName}': shared producer queue already initialized with name '${sharedProducerQueue.name}'`,
      );
    }
    return sharedProducerQueue;
  }
  sharedProducerConnection = connection ?? createProducerConnection();
  sharedProducerQueue = createWorkQueue(targetName, sharedProducerConnection);
  return sharedProducerQueue;
}

/**
 * Cleanly close the shared producer queue and connection.
 * Resets the shared singleton state so subsequent calls re-initialize cleanly.
 */
export async function closeProducerQueue(): Promise<void> {
  if (sharedProducerQueue) {
    await sharedProducerQueue.close();
    sharedProducerQueue = null;
  }
  if (sharedProducerConnection) {
    if (typeof (sharedProducerConnection as any).quit === 'function') {
      await (sharedProducerConnection as any).quit();
    }
    sharedProducerConnection = null;
  }
}

/**
 * Format deterministic BullMQ job ID: work-<rowId>-<generation> (jobs.md, no colons).
 */
export function formatJobId(rowId: string, generation: number): string {
  return `work-${rowId}-${generation}`;
}

/**
 * Add the BullMQ job for an existing work row's current generation (jobs.md, Job IDs and Scheduling).
 * Shared by the producer and the reconciler so both use the same ID, delay rule and retry options.
 *
 * - The ID is deterministic, so adding an ID that already exists is ignored by BullMQ.
 * - delay = max(0, run_at - now): a restored job never runs early and never moves run_at.
 * - Bounded by PRODUCER_ENQUEUE_TIMEOUT_MS. Throws on timeout or rejection; the caller decides what a
 *   failure means for the row.
 */
export async function addWorkJob(
  queue: Queue,
  row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>,
  shard: ShardId,
): Promise<{ jobId: string; delayMs: number }> {
  const jobId = formatJobId(row.id, row.generation);
  const delayMs = Math.max(0, row.runAt.getTime() - Date.now());

  const jobOpts: JobsOptions = {
    jobId,
    delay: delayMs,
    attempts: BULLMQ_JOB_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: WORK_BACKOFF_DELAY_MS,
    },
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Valkey enqueue timed out after ${PRODUCER_ENQUEUE_TIMEOUT_MS}ms`));
      }, PRODUCER_ENQUEUE_TIMEOUT_MS);
      timer.unref?.();
    });

    const addPromise = queue.add(
      row.kind,
      { rowId: row.id, generation: row.generation, shard },
      jobOpts,
    );

    // Safely log late settlement so an unhandled rejection doesn't crash the process
    addPromise.catch((err) => {
      console.warn(
        `[enqueue:late_rejection] job_id=${jobId} row_id=${row.id} generation=${row.generation} shard=${shard}: ${sanitizeError(err)}`,
      );
    });

    await Promise.race([addPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { jobId, delayMs };
}

/**
 * Enqueue a work row (jobs.md, ADR 0002, ADR 0003):
 * 1. Validates shard identifier ('A' | 'B').
 * 2. Writes Postgres row first (committed fact).
 * 3. Normal creation sets available_at = run_at + 2 minutes.
 * 4. Enqueues to BullMQ carrying rowId, generation, and shard identifier.
 * 5. Bounded enqueue: on timeout, Valkey rejection, or queue-construction failure,
 *    updates available_at = NOW() only for matching generation while still pending.
 *    Logs errors safely without discarding or hanging.
 */
export async function enqueueWorkRow(
  prisma: PrismaClient,
  kind: string,
  options: EnqueueOptions,
): Promise<WorkRow> {
  if (!options?.shard || (options.shard !== 'A' && options.shard !== 'B')) {
    throw new Error(`Enqueue requires a valid shard ('A' | 'B'), got: '${options?.shard}'`);
  }

  const runAt = options?.runAt ?? new Date();
  const availableAt = new Date(runAt.getTime() + 2 * 60 * 1000);

  const row = await prisma.workRow.create({
    data: {
      kind,
      payload: options?.payload ?? null,
      runAt,
      availableAt,
      status: 'pending',
      generation: 1,
      executionAttempts: 0,
    },
  });

  const jobId = formatJobId(row.id, row.generation);

  try {
    const queue = options.queue ?? getProducerQueue(options.queueName);
    await addWorkJob(queue, row, options.shard);
  } catch (err: any) {
    console.warn(
      `[enqueue:failure] job_id=${jobId} row_id=${row.id} generation=${row.generation} shard=${options.shard}: ${sanitizeError(err)}`,
    );
    // Enqueue timed out, rejected, or queue-construction failed.
    // Update available_at only for the matching generation while still pending.
    await prisma.$executeRaw`
      UPDATE work_rows
      SET available_at = NOW(), updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND generation = ${row.generation}
        AND status = 'pending'
    `;
  }

  return row;
}
