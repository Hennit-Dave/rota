import { createShards } from '../../db/clients.js';
import { createWorkerConnection } from '../connection.js';
import { createWorkWorker } from '../worker.js';

// Child worker that commits the claim and immediately aborts via SIGKILL
const queueName = process.env.CRASH_QUEUE_NAME || 'proof-crash';
const leaseMs = Number(process.env.CRASH_LEASE_MS) || 6_000;

const shards = createShards({ primaryMax: 2 });
const connection = createWorkerConnection();

const handlers = {
  'proof-crash': async (ctx: any) => {
    console.log(`[CHILD:CLAIMED] ${ctx.row.id} claim_token=${ctx.claimToken} attempts=${ctx.row.executionAttempts}`);
    // Abrupt termination immediately after claim commitment (graceful shutdown is prohibited)
    console.log('[CHILD:KILL] Abruptly terminating process with SIGKILL...');
    process.kill(process.pid, 'SIGKILL');
  },
};

const worker = createWorkWorker(shards.A.primary, handlers, {
  queueName,
  connection,
  leaseMs,
  maxAttempts: 5,
});

worker.on('ready', () => {
  console.log('[CHILD:READY]');
});
