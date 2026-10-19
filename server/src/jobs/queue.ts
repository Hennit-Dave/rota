import { Queue, type JobsOptions } from 'bullmq';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import {
  BULLMQ_JOB_ATTEMPTS,
  PRODUCER_ENQUEUE_TIMEOUT_MS,
  WORK_BACKOFF_DELAY_MS,
} from './config.js';
import { createProducerConnection } from './connection.js';

export const WORK_QUEUE_NAME = 'work';

export interface EnqueueOptions {
  payload?: any;
  runAt?: Date;
  queue?: Queue;
}

export function createWorkQueue(queueName = WORK_QUEUE_NAME, connection = createProducerConnection()): Queue {
  return new Queue(queueName, {
    connection,
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}

/**
 * Format deterministic BullMQ job ID: work-<rowId>-<generation> (jobs.md, no colons).
 */
export function formatJobId(rowId: string, generation: number): string {
  return `work-${rowId}-${generation}`;
}

/**
 * Enqueue a work row (jobs.md, ADR 0002, ADR 0003):
 * 1. Writes Postgres row first (committed fact).
 * 2. Normal creation sets available_at = run_at + 2 minutes.
 * 3. Enqueues to BullMQ with deterministic jobId and delay.
 * 4. Two-second bounded enqueue timeout: on timeout or Valkey rejection, updates available_at = NOW()
 *    only for matching generation while still pending. Never resets status or overwrites claims.
 */
export async function enqueueWorkRow(
  prisma: PrismaClient,
  kind: string,
  options?: EnqueueOptions,
): Promise<WorkRow> {
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

  const queue = options?.queue ?? createWorkQueue();
  const jobId = formatJobId(row.id, row.generation);
  const delay = Math.max(0, runAt.getTime() - Date.now());

  const jobOpts: JobsOptions = {
    jobId,
    delay,
    attempts: BULLMQ_JOB_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: WORK_BACKOFF_DELAY_MS,
    },
  };

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Valkey enqueue timed out after ${PRODUCER_ENQUEUE_TIMEOUT_MS}ms`));
    }, PRODUCER_ENQUEUE_TIMEOUT_MS);
    timer.unref?.();
  });

  const addPromise = queue.add(kind, { rowId: row.id, generation: row.generation }, jobOpts);

  // Catch late settlement so an unhandled rejection doesn't crash the process
  addPromise.catch((err) => {
    // Late rejection logged; Postgres row remains pending with available_at=NOW()
  });

  try {
    await Promise.race([addPromise, timeoutPromise]);
  } catch (err) {
    // Enqueue timed out or rejected.
    // Update available_at only for the matching generation while still pending (Implementation detail 1).
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
