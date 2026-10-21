// Configuration constants for the job queue and worker execution engine (jobs.md, ADR 0003).

export const WORK_LEASE_MS = Number(process.env.WORK_LEASE_MS) || 30_000;
export const WORK_MAX_ATTEMPTS = Number(process.env.WORK_MAX_ATTEMPTS) || 5;
// Cap on consecutive sweep recoveries of a row whose job failed before it was ever claimed (ADR 0004).
// Its own setting; it defaults to the attempt budget so no new number is invented.
export const WORK_MAX_RECOVERIES = Number(process.env.WORK_MAX_RECOVERIES) || WORK_MAX_ATTEMPTS;
export const WORK_BACKOFF_DELAY_MS = Number(process.env.WORK_BACKOFF_DELAY_MS) || 2_000;

// Producer connection timeouts (enqueue path)
export const PRODUCER_CONNECT_TIMEOUT_MS = 2_000;
export const PRODUCER_COMMAND_TIMEOUT_MS = 2_000;
export const PRODUCER_MAX_RETRIES = 1;
export const PRODUCER_ENQUEUE_TIMEOUT_MS = 2_000;

// BullMQ worker lock & stall check settings
export const BULLMQ_LOCK_DURATION_MS = Number(process.env.BULLMQ_LOCK_DURATION_MS) || 30_000;
export const BULLMQ_STALLED_INTERVAL_MS = Number(process.env.BULLMQ_STALLED_INTERVAL_MS) || 15_000;
export const BULLMQ_MAX_STALLED_COUNT = Number(process.env.BULLMQ_MAX_STALLED_COUNT) || 2;
export const BULLMQ_JOB_ATTEMPTS = Number(process.env.BULLMQ_JOB_ATTEMPTS) || 5;

// Reconciliation sweep (jobs.md, Recovery triggers; ADR 0004). 30 minutes and 100 rows are approved
// demo trade-offs, not brief requirements. The interval is about Neon compute hours (jobs.md).
export const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS) || 1_800_000;
export const RECONCILE_BATCH_SIZE = Number(process.env.RECONCILE_BATCH_SIZE) || 100;
