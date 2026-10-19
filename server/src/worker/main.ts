import { createShards } from '../db/clients.js';
import { createWorkerConnection, verifyNoEviction } from '../jobs/connection.js';
import {
  formatJobFailedLog,
  formatWorkerError,
  formatWorkerInitError,
} from '../jobs/redact.js';
import { createWorkWorker } from '../jobs/worker.js';

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

// In PR 2, handlers are test handlers; email handler arrives in PR 3
const handlers = {
  test: async (ctx: any) => {
    console.log(`[job:test] processing row ${ctx.row.id}`);
  },
};

const worker = createWorkWorker(shards, handlers, { connection: redis });

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

async function shutdown(signal: NodeJS.Signals) {
  console.log(`worker received ${signal}, closing`);
  await worker.close();
  await redis.quit();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
