import { loadBundledBlocklist } from '../auth/blocklist.js';
import { loadAuthConfig, loadJwtSecret, type AuthConfig } from '../auth/config.js';
import { createPasswordService } from '../auth/password.js';
import { createTokenService } from '../auth/tokens.js';
import { createShards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { createLogger } from '../http/logger.js';
import { createProducerConnection } from '../jobs/connection.js';
import { sanitizeError } from '../jobs/redact.js';
import { createRateLimiter } from '../ratelimit/limiter.js';
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
try {
  port = readPort();
  config = loadAuthConfig();
  secret = loadJwtSecret();
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
const limiter = createRateLimiter(redis);

const app = createApp({
  logger,
  auth: { db: identityDb(shards), tokens, passwords, limiter, config, blocklist },
  teams: { shards, tokens, limiter, config },
});

const server = app.listen(port, (error) => {
  if (error) throw error;
  console.log(`api listening on port ${port}`);
});

async function shutdown(signal: NodeJS.Signals) {
  console.log(`api received ${signal}, closing`);
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  redis.disconnect();
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
  console.log('api closed');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
