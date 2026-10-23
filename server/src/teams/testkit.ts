import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import type { Redis } from 'ioredis';
import { createApp } from '../api/app.js';
import { loadAuthConfig, type AuthConfig } from '../auth/config.js';
import { createRequireAuth } from '../auth/middleware.js';
import { createSession } from '../auth/sessions.js';
import type { Reply } from '../auth/testkit.js';
import { createTokenService, type TokenService } from '../auth/tokens.js';
import { createTestShards, type Shards } from '../db/clients.js';
import { identityDb } from '../db/identity.js';
import { shardFor, type ShardId } from '../db/shard.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createLogger } from '../http/logger.js';
import { installPostRoutes, installPreRoutes } from '../http/pipeline.js';
import { validateRequest } from '../http/validate.js';
import { createProducerConnection } from '../jobs/connection.js';
import { createRateLimiter, type RateRuleConfigOverrides } from '../ratelimit/limiter.js';
import { createRequireTeamRole } from './middleware.js';
import type { Role } from './permissions.js';
import { createTeamsRouter } from './routes.js';
import { teamIdParams } from './schemas.js';

/**
 * Test harness for the team routes. A real HTTP server on a random port, the TEST shards (never the real ones), real Valkey
 * with a unique key prefix. Everything it creates it removes, and `stop()` asserts no rate-limit key was left behind.
 *
 * It serves TWO apps: the harness app (the real teams router plus ONE test-only route, `/_test/...`, that exists only here) and
 * the production `createApp`, so a test can prove the test-only route is not part of the production app.
 */
export interface TeamsTestOptions {
  rateLimits?: RateRuleConfigOverrides;
  /** Point the limiter at a Valkey that is not there, to prove team creation fails closed. */
  deadValkey?: boolean;
}

export interface TestSession {
  userId: string;
  accessToken: string;
}

export interface TeamsTestApp {
  base: string;
  /** The production createApp with the same dependencies and NO test-only route. */
  productionBase: string;
  /** The test shards' clients, NOT instrumented: for seeding and for the SQL assertions. */
  raw: Shards;
  config: AuthConfig;
  logLines(): string[];
  /** "A:User.findMany", "B:Membership.findUnique", "A:$queryRaw": every query the APP made, in order. */
  queryLog(): string[];
  clearQueryLog(): void;
  /** Makes the next team INSERT fail, to leave a directory row with no team (the orphan case, ADR 0013). */
  failTeamInserts(on: boolean): void;
  seedUser(name?: string): Promise<{ id: string; email: string }>;
  /** A session and access token for a seeded user, without a login. */
  signIn(userId: string): Promise<TestSession>;
  /**
   * A team with its Owner, written the way ADR 0013 requires: directory row first, then team and Owner membership.
   * `shard` picks a team ID that hashes to that shard. `skipDirectory` seeds the "membership but no directory row" case.
   */
  seedTeam(opts: { ownerId: string; shard?: ShardId; name?: string; skipDirectory?: boolean }): Promise<{ teamId: string; shard: ShardId }>;
  /** Directory row first, then the membership (the ADR 0013 write order). */
  addMember(teamId: string, userId: string, role: Exclude<Role, 'owner'>): Promise<void>;
  setRole(teamId: string, userId: string, role: Role): Promise<void>;
  /** Which shards hold a `teams` row for this ID: the SQL evidence of where a team landed. */
  shardsHoldingTeam(teamId: string): Promise<ShardId[]>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  get(path: string, headers?: Record<string, string>): Promise<Reply>;
  stop(): Promise<void>;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function startTeamsTestApp(options: TeamsTestOptions = {}): Promise<TeamsTestApp> {
  const base = loadAuthConfig({});
  const config: AuthConfig = { ...base, rateLimits: { ...base.rateLimits, ...options.rateLimits } };

  const raw = createTestShards({ primaryMax: 3 });

  // The app sees instrumented clients: they record every query and can be told to fail a team insert.
  const queries: string[] = [];
  let failInserts = false;
  const instrument = (client: PrismaClient, shard: ShardId): PrismaClient =>
    client.$extends({
      query: {
        async $allOperations({ model, operation, args, query }) {
          queries.push(`${shard}:${model ? `${model}.` : ''}${operation}`);
          if (failInserts && model === 'Team' && operation === 'create') throw new Error('injected team insert failure');
          return query(args);
        },
      },
    }) as unknown as PrismaClient;
  const shards: Shards = {
    A: { primary: instrument(raw.A.primary, 'A') },
    B: { primary: instrument(raw.B.primary, 'B') },
  };

  const redis: Redis = createProducerConnection(options.deadValkey ? 'redis://127.0.0.1:1' : undefined);
  if (options.deadValkey) redis.on('error', () => {});
  else await redis.connect();
  const prefix = `rl-test-${randomUUID()}`;
  const touchedKeys = new Set<string>();
  const limiter = createRateLimiter(redis, { prefix, onKey: (k) => touchedKeys.add(k) });

  const secret = new Uint8Array(32).fill(4);
  const tokens: TokenService = createTokenService({ secret, config });

  const lines: string[] = [];
  const logger = createLogger((l) => lines.push(l));

  // The harness app: the real router plus the one test-only route. The 403 proof needs an Owner/Manager-only action and none
  // exists yet (the shifts slice adds the real ones), so the route is registered HERE and nowhere in the production server.
  const harnessApp = express();
  installPreRoutes(harnessApp, logger);
  harnessApp.use('/teams', createTeamsRouter({ shards, tokens, limiter, logger, config }));
  const requireAuth = createRequireAuth({ tokens, db: identityDb(shards) });
  const requireTeamRole = createRequireTeamRole({ shards });
  const testOnly = Router();
  testOnly.get(
    '/teams/:teamId/owner-manager-action',
    validateRequest({ params: teamIdParams }),
    requireAuth,
    requireTeamRole('shifts.edit'),
    (req, res) => {
      res.json({ ok: true, role: req.teamContext!.role });
    },
  );
  harnessApp.use('/_test', testOnly);
  installPostRoutes(harnessApp, logger);

  const productionApp = createApp({ logger, teams: { shards, tokens, limiter, config } });

  const listen = async (app: express.Express) => {
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const harness = await listen(harnessApp);
  const production = await listen(productionApp);

  const userIds = new Set<string>();
  const teamIds = new Set<string>();

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(harness.url + path, {
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

  function uuidOnShard(shard?: ShardId): string {
    for (;;) {
      const id = randomUUID();
      if (!shard || shardFor(id) === shard) return id;
    }
  }

  return {
    base: harness.url,
    productionBase: production.url,
    raw,
    config,
    logLines: () => lines,
    queryLog: () => [...queries],
    clearQueryLog: () => void (queries.length = 0),
    failTeamInserts: (on) => void (failInserts = on),
    async seedUser(name = 'Seeded User') {
      const email = `t-${randomUUID()}@example.com`;
      const user = await raw.A.primary.user.create({ data: { email, name } });
      userIds.add(user.id);
      return { id: user.id, email };
    },
    async signIn(userId) {
      const session = await createSession(identityDb(raw), { userId, config, now: new Date() });
      const access = await tokens.sign({ userId, familyId: session.familyId });
      return { userId, accessToken: access.token };
    },
    async seedTeam({ ownerId, shard, name = 'Seeded Team', skipDirectory = false }) {
      const teamId = uuidOnShard(shard);
      const onShard = shardFor(teamId);
      teamIds.add(teamId);
      if (!skipDirectory) await raw.A.primary.userTeam.create({ data: { userId: ownerId, teamId } });
      await raw[onShard].primary.team.create({
        data: { id: teamId, name, timeZone: 'Africa/Lagos', memberships: { create: { userId: ownerId, role: 'owner' } } },
      });
      return { teamId, shard: onShard };
    },
    async addMember(teamId, userId, role) {
      await raw.A.primary.userTeam.create({ data: { userId, teamId } });
      await raw[shardFor(teamId)].primary.membership.create({ data: { teamId, userId, role } });
    },
    async setRole(teamId, userId, role) {
      await raw[shardFor(teamId)].primary.membership.update({
        where: { teamId_userId: { teamId, userId } },
        data: { role },
      });
    },
    async shardsHoldingTeam(teamId) {
      const found: ShardId[] = [];
      for (const id of ['A', 'B'] as const) {
        if ((await raw[id].primary.team.count({ where: { id: teamId } })) > 0) found.push(id);
      }
      return found;
    },
    post: (path, body, headers) => call('POST', path, body ?? {}, headers),
    get: (path, headers) => call('GET', path, undefined, headers),
    async stop() {
      await new Promise<void>((r) => harness.server.close(() => r()));
      await new Promise<void>((r) => production.server.close(() => r()));
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

      // Teams made through the API are found by their members. Deleting a team cascades to its memberships; deleting a user
      // cascades to its sessions and directory rows.
      const ids = [...userIds];
      if (ids.length > 0) {
        for (const id of ['A', 'B'] as const) {
          const memberships = await raw[id].primary.membership.findMany({ where: { userId: { in: ids } }, select: { teamId: true } });
          for (const m of memberships) teamIds.add(m.teamId);
        }
      }
      for (const teamId of teamIds) await raw[shardFor(teamId)].primary.team.deleteMany({ where: { id: teamId } });
      if (ids.length > 0) await raw.A.primary.user.deleteMany({ where: { id: { in: ids } } });
      await raw.A.primary.$disconnect();
      await raw.B.primary.$disconnect();
    },
  };
}
