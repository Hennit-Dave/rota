import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import { createApp } from '../api/app.js';
import { createTestShards, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createLogger } from '../http/logger.js';
import { createProducerConnection } from '../jobs/connection.js';
import { createRateLimiter, type RateRuleConfigOverrides } from '../ratelimit/limiter.js';
import { createBlocklist, type PasswordBlocklist } from './blocklist.js';
import { loadAuthConfig, type AuthConfig } from './config.js';
import { argon2Hasher, createPasswordService, type PasswordHasher } from './password.js';
import { createSession } from './sessions.js';
import type { RecoveryDeps } from './recovery.js';
import { createTaskTracker, type TaskTracker } from './tasks.js';
import { createTokenService, type TokenService } from './tokens.js';

/**
 * Test harness for the auth routes. Real HTTP server on a random port, the TEST shards (never the real ones),
 * real Valkey with a unique key prefix. Everything it creates it removes: exact keys (no wildcard DEL) and the
 * users it tracked (which cascades to credentials, families and tokens). `stop()` also asserts nothing was left.
 */
export interface TestAppOptions {
  rateLimits?: RateRuleConfigOverrides;
  blocklist?: PasswordBlocklist;
  /** Point the limiter at a Valkey that is not there, to prove the routes fail closed. */
  deadValkey?: boolean;
  /** Makes the enqueue throw, to show what happens when the step after the answer fails. */
  failEnqueue?: boolean;
  /** Overrides for the recovery settings (the daily email cap). */
  recovery?: Partial<AuthConfig['recovery']>;
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface TestSession {
  familyId: string;
  refreshToken: string;
  accessToken: string;
}

export interface TestApp {
  base: string;
  db: PrismaClient;
  shards: Shards;
  config: AuthConfig;
  tokens: TokenService;
  /** Moves the app's clock (token issuance and verification) forward without waiting. */
  advanceClock(ms: number): void;
  /** The app's current time (real time plus any advance). Forged test tokens must be stamped with THIS. */
  now(): Date;
  /** How many Argon2 verifications have run since the app started. */
  verifyCount(): number;
  /** How many Argon2 hashes have been made since the app started (signup, reset). */
  hashCount(): number;
  /** Waits for the work a reset or magic-link request does after its answer (the token, the email row, the job). Call it before reading those rows. */
  settle(): Promise<void>;
  /** Makes the enqueue wait until the returned function is called, to show what a request does NOT wait for. */
  holdEnqueue(): () => void;
  /** Work rows the recovery routes asked to enqueue (nothing is really enqueued), in order. */
  enqueued(): string[];
  /** The email work rows written for a user's recovery tokens, newest first, with the raw link read from the frozen payload. */
  recoveryEmails(userId: string): Promise<Array<{ workRowId: string; tokenId: string; purpose: string; to: string; subject: string; link: string; secret: string }>>;
  logLines(): string[];
  newEmail(): string;
  seedUser(opts?: { email?: string; password?: string; name?: string }): Promise<{ id: string; email: string; password: string }>;
  /** A new session (family + first refresh token + access token) for a seeded user, without an Argon2 login. */
  startSession(userId: string): Promise<TestSession>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  get(path: string, headers?: Record<string, string>): Promise<Reply>;
  stop(): Promise<void>;
}

export async function startAuthTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const base = loadAuthConfig({});
  const config: AuthConfig = {
    ...base,
    rateLimits: { ...base.rateLimits, ...options.rateLimits },
    recovery: { ...base.recovery, ...options.recovery },
  };

  const shards = createTestShards({ primaryMax: 3 });
  const db = identityDb(shards);

  const redis: Redis = createProducerConnection(options.deadValkey ? 'redis://127.0.0.1:1' : undefined);
  if (options.deadValkey) redis.on('error', () => {});
  else await redis.connect();

  const prefix = `rl-test-${randomUUID()}`;
  const touchedKeys = new Set<string>();
  const limiter = createRateLimiter(redis, { prefix, onKey: (k) => touchedKeys.add(k) });

  let verifies = 0;
  let hashes = 0;
  const counting: PasswordHasher = {
    hash: (p) => (hashes++, argon2Hasher.hash(p)),
    verify: async (h, p) => (verifies++, argon2Hasher.verify(h, p)),
  };
  const passwords = createPasswordService(counting);
  await passwords.ready();

  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const secret = new Uint8Array(32).fill(3);
  const tokens = createTokenService({ secret, config, now });

  const lines: string[] = [];
  const logger = createLogger((l) => lines.push(l));
  const queued: string[] = [];
  let gate: Promise<void> | null = null;
  const tasks: TaskTracker = createTaskTracker((err) => lines.push(JSON.stringify({ level: 'error', msg: 'recovery_task_failed', reason: String(err) })));
  const recovery: RecoveryDeps = {
    mail: { from: 'Rota <notification@example.test>', replyTo: 'rota@example.test' },
    enqueue: async (_prisma, row) => {
      if (gate) await gate;
      if (options.failEnqueue) throw new Error('enqueue failed (test)');
      queued.push(row.id);
    },
  };
  const blocklist = options.blocklist ?? createBlocklist([]);
  const app = createApp({
    logger,
    auth: { db, tokens, passwords, limiter, config, blocklist, now },
    recovery: { db, tokens, passwords, limiter, config, blocklist, recovery, tasks, now },
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const emails = new Set<string>();
  const newEmail = () => {
    const e = `t-${randomUUID()}@example.com`;
    emails.add(e);
    return e;
  };

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(url + path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  return {
    base: url,
    db,
    shards,
    config,
    tokens,
    advanceClock: (ms) => void (offsetMs += ms),
    now,
    verifyCount: () => verifies,
    hashCount: () => hashes,
    settle: () => tasks.drain(),
    holdEnqueue() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    enqueued: () => [...queued],
    async recoveryEmails(userId) {
      const rows = await db.$queryRaw<Array<{ id: string; purpose: string; work_row_id: string; payload: any }>>`
        SELECT t.id, t.purpose::text AS purpose, w.id AS work_row_id, w.payload
        FROM auth_tokens t JOIN work_rows w ON w.id = t.email_work_row_id
        WHERE t.user_id = ${userId}::uuid ORDER BY t.created_at DESC`;
      return rows.map((r) => {
        const link: string = String(r.payload.text).match(/https?:\/\/\S+/)![0];
        return {
          workRowId: r.work_row_id,
          tokenId: r.id,
          purpose: r.purpose,
          to: r.payload.to[0],
          subject: r.payload.subject,
          link,
          secret: link.split('/').pop()!,
        };
      });
    },
    logLines: () => lines,
    newEmail,
    async seedUser(opts = {}) {
      const email = (opts.email ?? newEmail()).toLowerCase();
      emails.add(email);
      const password = opts.password ?? `seeded-password-${randomUUID()}`;
      const user = await db.user.create({
        data: { email, name: opts.name ?? 'Seeded User', credential: { create: { passwordHash: await argon2Hasher.hash(password) } } },
      });
      return { id: user.id, email, password };
    },
    async startSession(userId) {
      const created = await createSession(db, { userId, config, now: now() });
      const access = await tokens.sign({ userId, familyId: created.familyId });
      return { familyId: created.familyId, refreshToken: created.refreshToken, accessToken: access.token };
    },
    post: (path, body, headers) => call('POST', path, body ?? {}, headers),
    get: (path, headers) => call('GET', path, undefined, headers),
    async stop() {
      await tasks.drain();
      await new Promise<void>((r) => server.close(() => r()));
      if (!options.deadValkey) {
        if (touchedKeys.size > 0) await redis.del(...touchedKeys);
        let cursor = '0';
        const leftovers: string[] = [];
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 200);
          cursor = next;
          leftovers.push(...keys);
        } while (cursor !== '0');
        assert.deepEqual(leftovers, [], 'test left rate-limit keys behind');
      }
      redis.disconnect();
      if (emails.size > 0) {
        // Recovery email work rows have no owner row once the user (and its auth_tokens) cascade away, so remove them first (by the tokens' links).
        await db.$executeRaw`
          DELETE FROM work_rows WHERE id IN (
            SELECT t.email_work_row_id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ANY(${[...emails]}) AND t.email_work_row_id IS NOT NULL)`;
        await db.user.deleteMany({ where: { email: { in: [...emails] } } });
      }
      await shards.A.primary.$disconnect();
      await shards.B.primary.$disconnect();
    },
  };
}
