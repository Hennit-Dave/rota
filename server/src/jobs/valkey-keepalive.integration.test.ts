import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Redis } from 'ioredis';
import { createProducerConnection } from './connection.js';
import { createReconciler, type ReconcileTrigger } from './reconcile.js';
import { localValkeyAvailable, startLocalValkey, type LocalValkey } from './valkey.testkit.js';

// Issue #79 / ADR 0041: Aiven closes a client connection that has sent nothing for `valkey_timeout` seconds. The worker's sweep
// connection sat idle between sweeps, so it was closed and reopened over and over, and every reopening started a reconciliation
// pass on both Neon shards: Neon never went idle and the Free allowance ran out (ADR 0040, incident).
//
// The same thing is reproduced here in seconds: a DISPOSABLE local Valkey with a 1-second idle timeout (jobs.md: never the shared
// instance; nothing here reads VALKEY_URL) and a keep-alive interval well inside it. No Postgres: the reconciler's pass is a stub
// that only records why it ran. Needs `valkey-server` on PATH, or LOCAL_VALKEY_BIN; without it the tests skip, with this reason.
const available = await localValkeyAvailable();
const skip = available ? false : 'valkey-server not found: install Valkey or set LOCAL_VALKEY_BIN';

/** The server's idle timeout. Valkey counts it in whole seconds; 1 is the shortest that still means "on". */
const IDLE_TIMEOUT_SECONDS = 1;
/** The keep-alive under test, well inside the timeout (production: 15 s against Aiven's timeout, ADR 0041). */
const KEEPALIVE_MS = 300;
/** How long each test watches: several times the idle timeout, so an idle connection is certainly closed in it. */
const WATCH_MS = 4_000;

let valkey: LocalValkey;
let url: string;
const opened: Redis[] = [];

before(async () => {
  if (!available) return;
  valkey = await startLocalValkey({ idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS });
  url = `redis://127.0.0.1:${valkey.port}`;
});

after(async () => {
  for (const r of opened) r.disconnect();
  if (!available) return;
  await valkey.dispose();
});

function countCloses(redis: Redis): { closes: number } {
  const seen = { closes: 0 };
  redis.on('close', () => seen.closes++);
  redis.on('error', () => {}); // a server-side close can surface as ECONNRESET; the count above is what is checked
  opened.push(redis);
  return seen;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('control: the local server really closes a client that sends nothing (the test can see the bug)', { skip }, async () => {
  const bare = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const seen = countCloses(bare);
  await bare.connect();
  await wait(WATCH_MS);
  assert.ok(seen.closes >= 1, `an idle client with no keep-alive should have been closed at least once in ${WATCH_MS} ms`);
});

test('a producer connection stays open through the server idle timeout (issue #79)', { skip }, async () => {
  const redis = createProducerConnection(url, undefined, KEEPALIVE_MS);
  const seen = countCloses(redis);
  await redis.connect();
  await wait(WATCH_MS);
  assert.equal(seen.closes, 0, `the connection was closed ${seen.closes} time(s) while idle: the keep-alive did not keep it open`);
  assert.equal(redis.status, 'ready');
});

test('the reconciler runs no reconnect pass while its connection is only idle (issue #79)', { skip }, async () => {
  const connection = createProducerConnection(url, undefined, KEEPALIVE_MS);
  countCloses(connection);
  await connection.connect();

  const triggers: ReconcileTrigger[] = [];
  const reconciler = createReconciler(
    async (trigger) => {
      triggers.push(trigger);
    },
    { reconnectSource: connection, intervalMs: 3_600_000 }, // no timed pass inside the window
  );
  try {
    await wait(WATCH_MS);
    assert.deepEqual(triggers, ['startup'], `passes run while the connection was only idle: ${triggers.join(', ')}`);
  } finally {
    await reconciler.stop();
  }
});
