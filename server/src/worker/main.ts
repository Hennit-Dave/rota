import { createShards } from '../db/clients.js';
import { createWorkerConnection, verifyNoEviction } from '../jobs/connection.js';
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
  console.error(`worker failed to initialize valkey connection: ${err.message}`);
  process.exit(1);
}

// In PR 2, handlers are test handlers; email handler arrives in PR 3
const handlers = {
  test: async (ctx: any) => {
    console.log(`[job:test] processing row ${ctx.row.id}`);
  },
};

const worker = createWorkWorker(shards.A.primary, handlers, { connection: redis });

worker.on('ready', () => {
  console.log('worker running');
});

worker.on('error', (err) => {
  console.error(`worker error: ${err.message}`);
});

worker.on('failed', (job, err) => {
  console.warn(`job ${job?.id} failed: ${err.message}`);
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
