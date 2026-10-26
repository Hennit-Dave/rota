import { loadBundledBlocklist } from '../auth/blocklist.js';
import { loadAuthConfig, loadJwtSecret, type AuthConfig } from '../auth/config.js';
import { createPasswordService } from '../auth/password.js';
import { createTokenService } from '../auth/tokens.js';
import { createShards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { createLogger } from '../http/logger.js';
import { createProducerConnection, recycleIfStale } from '../jobs/connection.js';
import { loadSenderConfig } from '../jobs/mail.js';
import { closeProducerQueue, enqueueCommittedRow, getProducerQueue } from '../jobs/queue.js';
import type { InviteDeps } from '../invites/service.js';
import type { ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { sanitizeError } from '../jobs/redact.js';
import { createRateLimiter } from '../ratelimit/limiter.js';
import { createTaskTracker } from '../auth/tasks.js';
import { createApp } from './app.js';

// Local-development default only; a host injects its own PORT.
const DEFAULT_PORT = 3000;

function readPort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

const logger = createLogger();

// A bad or missing security setting stops the server before it listens (security.md): never start weaker.
let config: AuthConfig;
let secret: Uint8Array;
let port: number;
let mail: { from: string; replyTo: string };
try {
  port = readPort();
  config = loadAuthConfig();
  secret = loadJwtSecret();
  mail = loadSenderConfig();
} catch (err) {
  console.error(`api cannot start: ${sanitizeError(err)}`);
  process.exit(1);
}

// data.md: the API's pool is 5 per shard primary. Identity lives on shard A.
const shards = createShards({ primaryMax: 5 });

// Rate limiting uses the bounded producer-style connection: short timeouts, no offline queue, so a Valkey outage
// fails the limited routes closed (503) quickly instead of hanging them.
const redis = createProducerConnection();
let valkeyDown = false;
redis.on('error', (err) => {
  if (!valkeyDown) {
    valkeyDown = true;
    logger.error('valkey_unavailable', { reason: sanitizeError(err) });
  }
});
redis.on('ready', () => {
  if (valkeyDown) logger.info('valkey_recovered');
  valkeyDown = false;
});
void redis.connect().catch(() => {
  // Already reported through the 'error' event; ioredis keeps retrying in the background.
});

const passwords = createPasswordService();
await passwords.ready();

const blocklist = loadBundledBlocklist();
if (blocklist.size === 0) {
  logger.warn('password_blocklist_empty', { reason: 'no bundled blocklist yet (ADR 0005)' });
}

const tokens = createTokenService({ secret, config });
// A connection that went half-open (laptop sleep, a NAT that forgot the mapping) never emits 'close' or 'error', so ioredis keeps
// calling it ready while every command times out. A timeout on a ready connection replaces it (ADR 0018, issue #39). The request
// that hit the timeout still answers 503; the next one finds a live connection.
const limiter = createRateLimiter(redis, {
  onUnavailable: (cause) => {
    if (recycleIfStale(redis, cause)) {
      valkeyDown = true; // so the 'ready' handler above logs the recovery
      logger.warn('valkey_connection_recycled', { reason: 'no_reply_from_ready_connection' });
    }
  },
});

// Invitations: the email work row commits with the invitation, then this enqueues it. It never throws: a Valkey failure leaves the row eligible
// for the sweep (jobs.md). The queue uses its own bounded producer connection.
const invites: InviteDeps = {
  mail,
  config,
  enqueue: async (prisma, row, shard) => {
    await enqueueCommittedRow(prisma, row, shard, () => getProducerQueue());
  },
};

// Magic link and password reset (ADR 0020): the token and its email row commit together on shard A, then the job is enqueued (it never throws).
// The token and email row of a reset or magic-link request are made after the answer is sent (ADR 0020); shutdown waits for them.
const recoveryTasks = createTaskTracker((err) => logger.error('recovery_task_failed', { reason: sanitizeError(err) }));
const recovery = {
  db: identityDb(shards),
  tasks: recoveryTasks,
  tokens,
  passwords,
  limiter,
  config,
  blocklist,
  recovery: {
    mail,
    enqueue: async (prisma: PrismaClient, row: Pick<WorkRow, 'id' | 'kind' | 'generation' | 'runAt'>, shard: ShardId) => {
      await enqueueCommittedRow(prisma, row, shard, () => getProducerQueue());
    },
  },
};

const app = createApp({
  logger,
  auth: { db: identityDb(shards), tokens, passwords, limiter, config, blocklist },
  recovery,
  teams: { shards, tokens, limiter, config, invites },
  invitations: { shards, tokens, limiter, config, invites },
});

const server = app.listen(port, (error) => {
  if (error) throw error;
  console.log(`api listening on port ${port}`);
});

async function shutdown(signal: NodeJS.Signals) {
  console.log(`api received ${signal}, closing`);
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await recoveryTasks.drain();
  redis.disconnect();
  await closeProducerQueue();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
  console.log('api closed');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
