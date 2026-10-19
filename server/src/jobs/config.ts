// Configuration constants for the job queue and worker execution engine (jobs.md, ADR 0003).

export const WORK_LEASE_MS = Number(process.env.WORK_LEASE_MS) || 30_000;
export const WORK_MAX_ATTEMPTS = Number(process.env.WORK_MAX_ATTEMPTS) || 5;
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
