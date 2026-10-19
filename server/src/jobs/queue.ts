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
  queueName = process.env.WORK_QUEUE_NAME || WORK_QUEUE_NAME,
  connection = createProducerConnection(),
): Queue {
  return new Queue(queueName, {
    connection,
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}

/**
 * Get or create the shared producer queue singleton.
 * Reuses a single producer queue and connection across requests.
 */
export function getProducerQueue(queueName = process.env.WORK_QUEUE_NAME || WORK_QUEUE_NAME): Queue {
  if (!sharedProducerQueue) {
    sharedProducerConnection = createProducerConnection();
    sharedProducerQueue = createWorkQueue(queueName, sharedProducerConnection);
  }
  return sharedProducerQueue;
}

/**
 * Cleanly close the shared producer queue and connection.
 */
export async function closeProducerQueue(): Promise<void> {
  if (sharedProducerQueue) {
    await sharedProducerQueue.close();
    sharedProducerQueue = null;
  }
  if (sharedProducerConnection) {
    await sharedProducerConnection.quit();
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
  const delay = Math.max(0, runAt.getTime() - Date.now());

  let timer: NodeJS.Timeout | undefined;
  try {
    const queue = options.queue ?? getProducerQueue(options.queueName);

    const jobOpts: JobsOptions = {
      jobId,
      delay,
      attempts: BULLMQ_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: WORK_BACKOFF_DELAY_MS,
      },
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Valkey enqueue timed out after ${PRODUCER_ENQUEUE_TIMEOUT_MS}ms`));
      }, PRODUCER_ENQUEUE_TIMEOUT_MS);
      timer.unref?.();
    });

    const addPromise = queue.add(
      kind,
      { rowId: row.id, generation: row.generation, shard: options.shard },
      jobOpts,
    );

    // Safely log late settlement so an unhandled rejection doesn't crash the process
    addPromise.catch((err) => {
      console.warn(
        `[enqueue:late_rejection] job_id=${jobId} row_id=${row.id} generation=${row.generation} shard=${options.shard}: ${sanitizeError(err)}`,
      );
    });

    await Promise.race([addPromise, timeoutPromise]);
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
  } finally {
    if (timer) clearTimeout(timer);
  }

  return row;
}
