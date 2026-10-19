import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DelayedError, Job, Worker, type Processor } from 'bullmq';
import type { Shards } from '../db/clients.js';
import type { ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import {
  BULLMQ_LOCK_DURATION_MS,
  BULLMQ_MAX_STALLED_COUNT,
  BULLMQ_STALLED_INTERVAL_MS,
  WORK_LEASE_MS,
  WORK_MAX_ATTEMPTS,
} from './config.js';
import { createWorkerConnection } from './connection.js';
import { resolveQueueName, WORK_QUEUE_NAME } from './queue.js';
import { sanitizeError } from './redact.js';

export class ContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentionError';
  }
}

export interface JobContext {
  prisma: PrismaClient;
  row: WorkRow;
  job: Job;
  claimToken: string;
  renewLease: (leaseMs?: number) => Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export type ShardResolver =
  | PrismaClient
  | Shards
  | Record<ShardId, { primary: PrismaClient }>
  | Record<ShardId, PrismaClient>;

export function resolvePrismaClient(resolver: ShardResolver, shard: ShardId): PrismaClient {
  if ('$queryRaw' in resolver) {
    return resolver as PrismaClient;
  }
  const shardEntry = (resolver as any)[shard];
  if (!shardEntry) {
    throw new Error(`No database client configured for shard '${shard}'`);
  }
  return shardEntry.primary ?? shardEntry;
}

export interface WorkerOptions {
  queueName?: string;
  connection?: ReturnType<typeof createWorkerConnection>;
  leaseMs?: number;
  maxAttempts?: number;
  concurrency?: number;
  autorun?: boolean;
}

/**
 * Renew the claim lease immediately before external calls (jobs.md, Ownership rule 4).
 * Returns true if the lease was renewed, false if ownership was lost.
 */
export async function renewClaimLease(
  prisma: PrismaClient,
  rowId: string,
  generation: number,
  claimToken: string,
  leaseMs = WORK_LEASE_MS,
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE work_rows
    SET claim_expires_at = NOW() + (${leaseMs} || ' milliseconds')::interval,
        updated_at = NOW()
    WHERE id = ${rowId}::uuid
      AND generation = ${generation}
      AND claim_token = ${claimToken}::uuid
      AND status = 'claimed'::"work_status"
  `;
  return updated > 0;
}

/**
 * Creates a BullMQ worker processor enforcing:
 * - Shard routing by validated server-generated shard identifier ('A' | 'B')
 * - Atomic claim with generation match, run_at <= now, and pending or expired lease
 * - Explicit failure on unsupported job kinds (never marks unperformed work done)
 * - Missing work row detection without silently disguising routing failures
 * - Contention detection without attempt increments or completion
 * - Three-field check on renewal, release, completion, and failure
 * - Early fire detection via job.moveToDelayed and DelayedError
 * - Attempt ceiling (attempt 5 may succeed; failure on attempt 5 marks row failed; no 6th execution)
 * - Structured execution logging (job ID, row ID, generation, attempts, outcome, duration)
 */
export function createWorkProcessor(
  shards: ShardResolver,
  handlers: Record<string, JobHandler>,
  options?: { leaseMs?: number; maxAttempts?: number },
): Processor {
  const leaseMs = options?.leaseMs ?? WORK_LEASE_MS;
  const maxAttempts = options?.maxAttempts ?? WORK_MAX_ATTEMPTS;

  return async (job: Job, token?: string) => {
    const startTime = performance.now();
    const { rowId, generation, shard } = job.data as {
      rowId: string;
      generation: number;
      shard?: string;
    };

    // 0. Validate shard identity and resolve shard primary client
    if (!shard || (shard !== 'A' && shard !== 'B')) {
      throw new Error(`Job ${job.id} has invalid or missing shard identifier: '${shard}'`);
    }

    const prisma = resolvePrismaClient(shards, shard as ShardId);
    const claimToken = randomUUID();

    // 1. Atomic claim in Postgres (jobs.md, Ownership rule 1)
    const claimed = await prisma.$queryRaw<WorkRow[]>`
      UPDATE work_rows
      SET status = 'claimed'::"work_status",
          claim_token = ${claimToken}::uuid,
          claim_expires_at = NOW() + (${leaseMs} || ' milliseconds')::interval,
          execution_attempts = execution_attempts + 1,
          updated_at = NOW()
      WHERE id = ${rowId}::uuid
        AND generation = ${generation}
        AND run_at <= NOW()
        AND (status = 'pending'::"work_status" OR (status = 'claimed'::"work_status" AND claim_expires_at < NOW()))
        AND execution_attempts < ${maxAttempts}
      RETURNING *;
    `;

    if (claimed.length > 0 && claimed[0]) {
      const rawRow = claimed[0] as any;
      const row: WorkRow = {
        id: rawRow.id,
        kind: rawRow.kind,
        status: rawRow.status,
        generation: Number(rawRow.generation),
        executionAttempts: Number(rawRow.execution_attempts ?? rawRow.executionAttempts ?? 0),
        runAt: new Date(rawRow.run_at ?? rawRow.runAt),
        availableAt: new Date(rawRow.available_at ?? rawRow.availableAt),
        claimToken: rawRow.claim_token ?? rawRow.claimToken ?? null,
        claimExpiresAt: rawRow.claim_expires_at || rawRow.claimExpiresAt ? new Date(rawRow.claim_expires_at ?? rawRow.claimExpiresAt) : null,
        failureReason: rawRow.failure_reason ?? rawRow.failureReason ?? null,
        payload: rawRow.payload ?? null,
        firstAttemptAt: rawRow.first_attempt_at || rawRow.firstAttemptAt ? new Date(rawRow.first_attempt_at ?? rawRow.firstAttemptAt) : null,
        sentAt: rawRow.sent_at || rawRow.sentAt ? new Date(rawRow.sent_at ?? rawRow.sentAt) : null,
        providerMessageId: rawRow.provider_message_id ?? rawRow.providerMessageId ?? null,
        createdAt: new Date(rawRow.created_at ?? rawRow.createdAt),
        updatedAt: new Date(rawRow.updated_at ?? rawRow.updatedAt),
      };

      const handler = handlers[row.kind];
      if (!handler) {
        // Unknown handler: explicit failure, never mark unperformed work done (Rule 1)
        const durationMs = performance.now() - startTime;
        const err = new Error(`Unsupported job kind: '${row.kind}'`);
        console.error(
          `[job:execution] job_id=${job.id} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} outcome=failed duration_ms=${durationMs.toFixed(2)} reason=unsupported_job_kind`,
        );

        if (row.executionAttempts >= maxAttempts) {
          await prisma.$executeRaw`
            UPDATE work_rows
            SET status = 'failed'::"work_status",
                failure_reason = ${sanitizeError(err)},
                updated_at = NOW()
            WHERE id = ${row.id}::uuid
              AND generation = ${generation}
              AND claim_token = ${claimToken}::uuid
              AND status = 'claimed'::"work_status"
          `;
        } else {
          await prisma.$executeRaw`
            UPDATE work_rows
            SET status = 'pending'::"work_status",
                claim_token = NULL,
                claim_expires_at = NULL,
                updated_at = NOW()
            WHERE id = ${row.id}::uuid
              AND generation = ${generation}
              AND claim_token = ${claimToken}::uuid
              AND status = 'claimed'::"work_status"
          `;
        }
        throw err;
      }

      const ctx: JobContext = {
        prisma,
        row,
        job,
        claimToken,
        renewLease: (extraMs?: number) =>
          renewClaimLease(prisma, row.id, generation, claimToken, extraMs ?? leaseMs),
      };

      try {
        await handler(ctx);

        // Success: Complete with 3-field ownership check
        const completed = await prisma.$executeRaw`
          UPDATE work_rows
          SET status = 'done'::"work_status",
              updated_at = NOW()
          WHERE id = ${row.id}::uuid
            AND generation = ${generation}
            AND claim_token = ${claimToken}::uuid
            AND status = 'claimed'::"work_status"
        `;

        const durationMs = performance.now() - startTime;
        if (completed === 0) {
          // Ownership was lost during execution; abort
          console.warn(
            `[job:execution] job_id=${job.id} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} outcome=lost_ownership duration_ms=${durationMs.toFixed(2)}`,
          );
          return;
        }

        console.log(
          `[job:execution] job_id=${job.id} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} outcome=done duration_ms=${durationMs.toFixed(2)}`,
        );
      } catch (err: any) {
        // Handler failure
        const durationMs = performance.now() - startTime;
        if (row.executionAttempts >= maxAttempts) {
          const sanitizedErr = sanitizeError(err);
          // Failure on attempt ceiling marks row failed; do not release claim
          await prisma.$executeRaw`
            UPDATE work_rows
            SET status = 'failed'::"work_status",
                failure_reason = ${sanitizedErr || 'attempt_budget_exhausted'},
                updated_at = NOW()
            WHERE id = ${row.id}::uuid
              AND generation = ${generation}
              AND claim_token = ${claimToken}::uuid
              AND status = 'claimed'::"work_status"
          `;
          console.error(
            `[job:execution] job_id=${job.id} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} outcome=failed duration_ms=${durationMs.toFixed(2)} reason=${sanitizedErr || 'attempt_budget_exhausted'}`,
          );
          throw err;
        } else {
          const sanitizedErr = sanitizeError(err);
          // Retryable failure: release claim and rethrow for BullMQ exponential backoff
          await prisma.$executeRaw`
            UPDATE work_rows
            SET status = 'pending'::"work_status",
                claim_token = NULL,
                claim_expires_at = NULL,
                updated_at = NOW()
            WHERE id = ${row.id}::uuid
              AND generation = ${generation}
              AND claim_token = ${claimToken}::uuid
              AND status = 'claimed'::"work_status"
          `;
          console.warn(
            `[job:execution] job_id=${job.id} row_id=${row.id} generation=${row.generation} attempts=${row.executionAttempts} outcome=retryable_failure duration_ms=${durationMs.toFixed(2)} reason=${sanitizedErr || 'handler_error'}`,
          );
          throw err;
        }
      }

      return;
    }

    // 2. Claim missed (0 rows updated). Inspect reason (jobs.md, Ownership rule 2):
    const current = await prisma.$queryRaw<
      Array<{
        status: string;
        generation: number;
        run_at: Date;
        claim_expires_at: Date | null;
        execution_attempts: number;
      }>
    >`
      SELECT status::text, generation, run_at, claim_expires_at, execution_attempts
      FROM work_rows
      WHERE id = ${rowId}::uuid
    `;

    if (current.length === 0 || !current[0]) {
      // Missing work row: must never silently disguise routing failures
      throw new Error(`Work row ${rowId} not found on shard ${shard}`);
    }
    const cur = current[0];

    // Stale job or already completed/failed
    if (cur.generation !== generation || cur.status === 'done' || cur.status === 'failed') {
      return;
    }

    // Early fire: move to delayed and throw DelayedError
    if (new Date(cur.run_at).getTime() > Date.now()) {
      if (token) {
        await job.moveToDelayed(new Date(cur.run_at).getTime(), token);
      }
      console.log(
        `[job:execution] job_id=${job.id} row_id=${rowId} generation=${generation} attempts=${cur.execution_attempts} outcome=delayed`,
      );
      throw new DelayedError();
    }

    // Active claim contention: live claim by another execution (including live 5th attempt!)
    if (
      cur.status === 'claimed' &&
      cur.claim_expires_at &&
      new Date(cur.claim_expires_at).getTime() >= Date.now()
    ) {
      console.warn(
        `[job:execution] job_id=${job.id} row_id=${rowId} generation=${generation} attempts=${cur.execution_attempts} outcome=contention`,
      );
      throw new ContentionError(`Row ${rowId} under active claim until ${cur.claim_expires_at.toISOString()}`);
    }

    // Attempt ceiling exhausted while NOT under an active live claim
    if (cur.execution_attempts >= maxAttempts) {
      await prisma.$executeRaw`
        UPDATE work_rows
        SET status = 'failed'::"work_status",
            failure_reason = 'attempt_budget_exhausted',
            updated_at = NOW()
        WHERE id = ${rowId}::uuid
          AND generation = ${generation}
          AND execution_attempts >= ${maxAttempts}
          AND (status = 'pending'::"work_status" OR (status = 'claimed'::"work_status" AND claim_expires_at < NOW()))
      `;
      console.error(
        `[job:execution] job_id=${job.id} row_id=${rowId} generation=${generation} attempts=${cur.execution_attempts} outcome=exhausted`,
      );
      throw new Error(`Execution attempts (${cur.execution_attempts}) reached maximum (${maxAttempts})`);
    }

    // Fallback: transient contention or race
    throw new Error(`Claim missed on row ${rowId}; retryable`);
  };
}

export function createWorkWorker(
  shards: ShardResolver,
  handlers: Record<string, JobHandler> = {},
  options?: WorkerOptions,
): Worker {
  const queueName = resolveQueueName(options?.queueName);
  const connection = options?.connection ?? createWorkerConnection();
  const processor = createWorkProcessor(shards, handlers, {
    leaseMs: options?.leaseMs,
    maxAttempts: options?.maxAttempts,
  });

  return new Worker(queueName, processor, {
    connection,
    concurrency: options?.concurrency ?? 1,
    autorun: options?.autorun,
    lockDuration: BULLMQ_LOCK_DURATION_MS,
    stalledInterval: BULLMQ_STALLED_INTERVAL_MS,
    maxStalledCount: BULLMQ_MAX_STALLED_COUNT,
  });
}
