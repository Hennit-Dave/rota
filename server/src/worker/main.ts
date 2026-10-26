import { createShards } from '../db/clients.js';
import {
  createProducerConnection,
  createWorkerConnection,
  verifyNoEviction,
} from '../jobs/connection.js';
import { createConsumer, startConsumerWatchdog } from '../jobs/consumer.js';
import { createWorkQueue, resolveQueueName } from '../jobs/queue.js';
import { startReconciler } from '../jobs/reconcile.js';
import {
  formatJobFailedLog,
  formatWorkerError,
  formatWorkerInitError,
} from '../jobs/redact.js';
import { createEmailHandler } from '../jobs/email.js';
import { loadResendConfig } from '../jobs/mail.js';
import { createResendClient } from '../jobs/resend.js';
import { createWorkWorker } from '../jobs/worker.js';
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

console.log('worker starting...');

// data.md: Worker uses primary clients only, max 3 connections per shard primary
const shards = createShards({ primaryMax: 3 });
const redis = createWorkerConnection();

try {
  await redis.connect();
  await verifyNoEviction(redis);
  console.log('valkey connected; maxmemory-policy verified as noeviction');
} catch (err: any) {
  console.error(formatWorkerInitError(err));
  process.exit(1);
}

// The Resend key is a secret that only the worker holds. A missing value stops the worker before it takes any work (same rule as the API's JWT secret).
let resendConfig: { apiKey: string; timeoutMs: number };
try {
  resendConfig = loadResendConfig();
} catch (err: any) {
  console.error(`worker cannot start: ${err.message}`);
  process.exit(1);
}

const handlers = {
  test: async (ctx: any) => {
    console.log(`[job:test] processing row ${ctx.row.id}`);
  },
  email: createEmailHandler({ resend: createResendClient(resendConfig) }),
};

// Every worker that gets built, including one rebuilt by the watchdog below, gets the same handlers.
function attach(worker: Worker) {
  worker.on('ready', () => {
    console.log('worker running');
  });

  worker.on('error', (err) => {
    console.error(formatWorkerError(err));
  });

  worker.on('failed', (job, err) => {
    console.warn(formatJobFailedLog(job?.id, err));
  });

  worker.on('completed', (job) => {
    console.log(`job ${job?.id} completed`);
  });
}

const makeWorker = (connection: Redis) => createWorkWorker(shards, handlers, { connection });
const firstWorker = makeWorker(redis);
attach(firstWorker);

// The consumer waits on Valkey with a blocking command, which a silently dead connection never answers, so the worker would sit idle
// until restarted. The watchdog probes it and rebuilds the consumer when it goes silent (ADR 0018, issue #39).
const watchdog = startConsumerWatchdog({
  consumer: { worker: firstWorker, connection: redis },
  rebuild: () => createConsumer({ makeWorker, attach }),
});

// Reconciliation sweep (jobs.md): its own bounded producer-style connection, so a hung Valkey cannot
// hang the sweep. Runs at startup, every RECONCILE_INTERVAL_MS, and after a Valkey reconnect.
const reconcileConnection = createProducerConnection();
const reconcileQueue = createWorkQueue(resolveQueueName(), reconcileConnection);
const reconciler = startReconciler(shards, reconcileQueue, { reconnectSource: reconcileConnection });

async function shutdown(signal: NodeJS.Signals) {
  console.log(`worker received ${signal}, closing`);
  await reconciler.stop();
  await watchdog.stop();
  const { worker, connection } = watchdog.current();
  await worker.close();
  await reconcileQueue.close();
  await connection.quit();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
