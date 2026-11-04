import { loadCacheConfig } from '../cache/config.js';
import { createTeamCache } from '../cache/store.js';
import { invalidateRosterAfterRenewalPayment } from '../cache/workerHooks.js';
import { createReductionBoundaryHandler, REDUCTION_BOUNDARY_KIND } from '../billing/reductions.js';
import { createStripeGateway } from '../billing/gateway.js';
import { loadStripeApiConfig } from '../billing/stripeConfig.js';
import { createStripeEventHandler } from '../billing/stripeEventJob.js';
import { createRenewalHandler, ensureRenewals, RENEWAL_KIND, type EnqueueRow } from '../billing/renewal.js';
import { loadRenewalConfig } from '../billing/renewalConfig.js';
import { createRuntimeShards } from '../db/runtimeShards.js';
import {
  createProducerConnection,
  createWorkerConnection,
  verifyNoEviction,
} from '../jobs/connection.js';
import { createConsumer, startConsumerWatchdog } from '../jobs/consumer.js';
import { createWorkQueue, enqueueCommittedRow, resolveQueueName } from '../jobs/queue.js';
import { startReconciler } from '../jobs/reconcile.js';
import {
  formatJobFailedLog,
  formatWorkerError,
  formatWorkerInitError,
} from '../jobs/redact.js';
import { createEmailHandler } from '../jobs/email.js';
import { loadResendConfig, loadSenderConfig } from '../jobs/mail.js';
import { createResendClient } from '../jobs/resend.js';
import { createWorkWorker } from '../jobs/worker.js';
import { loadPushConfig } from '../push/config.js';
import { createExpoPushClient } from '../push/expo.js';
import { createPushEventHandler, createPushHandler, createPushReceiptsHandler, PUSH_EVENT_KIND, PUSH_KIND, PUSH_RECEIPTS_KIND } from '../push/jobs.js';
import { createLogger } from '../http/logger.js';
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

console.log('worker starting...');

// data.md: Worker uses primary clients only, max 3 connections per shard primary
const shards = createRuntimeShards({ primaryMax: 3 }, 'worker');
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

// The worker READS from Stripe to learn which card a payment or a setup saved (ADR 0030): it holds the Stripe TEST key, and never the webhook signing secret.
// Same rule as the API: anything but an sk_test_ key stops it before it takes any work.
let stripeApiConfig: ReturnType<typeof loadStripeApiConfig>;
try {
  stripeApiConfig = loadStripeApiConfig();
} catch (err: any) {
  console.error(`worker cannot start: ${err.message}`);
  process.exit(1);
}
const stripe = createStripeGateway(stripeApiConfig);

// Renewals (ADR 0031): the grace period (a config value, Dave chose 7) and the sender of the Owner's emails. A bad value stops the worker before it takes any work.
let renewalConfig: ReturnType<typeof loadRenewalConfig>;
let sender: ReturnType<typeof loadSenderConfig>;
try {
  renewalConfig = loadRenewalConfig();
  sender = loadSenderConfig();
} catch (err: any) {
  console.error(`worker cannot start: ${err.message}`);
  process.exit(1);
}

// The sweep's own bounded producer-style connection (see below) also enqueues the work the jobs write: the next renewal, and the Owner's notices. It is made first so
// the handlers can use it. Enqueueing never throws; a Valkey failure leaves the row for the sweep (jobs.md).
const reconcileConnection = createProducerConnection();
const reconcileQueue = createWorkQueue(resolveQueueName(), reconcileConnection);
const enqueue: EnqueueRow = async (prisma, row, shard) => {
  await enqueueCommittedRow(prisma, row, shard, () => reconcileQueue);
};

// Push (ADR 0032): the Expo push client and its two settings. A bad value stops the worker before it takes any work. The worker holds no Expo or Firebase secret:
// the FCM key lives at Expo (EAS credentials), and enhanced push security is not used (a known gap, ADR 0032).
let pushConfig: ReturnType<typeof loadPushConfig>;
try {
  pushConfig = loadPushConfig();
} catch (err: any) {
  console.error(`worker cannot start: ${err.message}`);
  process.exit(1);
}
const expo = createExpoPushClient({ timeoutMs: pushConfig.sendTimeoutMs });

// The worker only INVALIDATES the cache, never reads it: a paid renewal can deactivate members, which changes the roster (ADR 0038). Its own bounded connection;
// a cache failure is reported by the cache and never stops a job. The same CACHE_ENABLED switch applies: off means nothing is written.
let cacheConfig: ReturnType<typeof loadCacheConfig>;
try {
  cacheConfig = loadCacheConfig();
} catch (err: any) {
  console.error(`worker cannot start: ${err.message}`);
  process.exit(1);
}
const cacheConnection = createProducerConnection();
cacheConnection.on('error', () => {});
void cacheConnection.connect().catch(() => {});
const cache = createTeamCache({ redis: cacheConnection, config: cacheConfig, logger: createLogger(), statsEveryMs: null });

const handlers = {
  test: async (ctx: any) => {
    console.log(`[job:test] processing row ${ctx.row.id}`);
  },
  email: createEmailHandler({ resend: createResendClient(resendConfig) }),
  // Stripe webhook events recorded by the API (ADR 0027). The worker only READS from Stripe (the saved card, ADR 0030) and writes our own tables.
  stripe_event: invalidateRosterAfterRenewalPayment(
    createStripeEventHandler({ shards, stripe, renewal: { graceDays: renewalConfig.graceDays, sender, enqueue } }),
    cache,
  ),
  // The renewal at the end of a period, and the Owner's retry (ADR 0031). It charges the saved card; only the verified webhook decides the outcome.
  [RENEWAL_KIND]: createRenewalHandler({ shards, stripe, graceDays: renewalConfig.graceDays, sender, enqueue }),
  // Push notifications (ADR 0032): fan out an event to its recipients, send to their devices, then read Expo's receipts.
  [PUSH_EVENT_KIND]: createPushEventHandler({ shards, enqueue }),
  [PUSH_KIND]: createPushHandler({ shards, enqueue, expo, config: pushConfig }),
  [PUSH_RECEIPTS_KIND]: createPushReceiptsHandler({ expo, config: pushConfig, enqueue }),
  // The check at the end of a period for a scheduled reduction (ADR 0029). It records ready, blocked or continuing and applies nothing (P6 does).
  [REDUCTION_BOUNDARY_KIND]: createReductionBoundaryHandler({ shards }),
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
// A subscription that activated before renewals existed has none yet: give it one (idempotent; it only adds where none exists).
void ensureRenewals(shards, enqueue)
  .then((made) => console.log(`renewals: ${made} created for subscriptions that had none`))
  .catch((err: any) => console.error(`renewals: could not check for missing renewals: ${err?.message ?? err}`));
const reconciler = startReconciler(shards, reconcileQueue, { reconnectSource: reconcileConnection });

async function shutdown(signal: NodeJS.Signals) {
  console.log(`worker received ${signal}, closing`);
  cache.stop();
  cacheConnection.disconnect();
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
