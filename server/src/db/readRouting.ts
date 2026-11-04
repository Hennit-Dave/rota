import type { RequestHandler, Response } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import { shardFor } from './shard.js';
import type { Shards } from './clients.js';

/**
 * Read routing and read-your-own-writes (data.md, brief p15, ADR 0037).
 *
 * `run` is the ONE function that decides which database a read uses. Nothing else calls `$replica()`; the plain `shards.X.primary` client always reads the
 * primary, which is what every auth, billing and permission read keeps doing. A read goes to the replica only if its route handler opts in by calling `run`.
 *
 * The reason for each decision (`DbRoute`) is put on the request log as `dbRoute`:
 *   - `primary-required`: the caller says this read must see the latest state (anything someone else may have just written).
 *   - `marker`: this user wrote less than 5 seconds ago (read-your-own-writes).
 *   - `startup`: this process started less than 5 seconds ago, so a write made just before a crash or deploy may have been forgotten.
 *   - `none`: no reason to use the primary, so the replica answered.
 *   - `replica-failed`: the replica could not answer (asleep too long, unreachable), so the primary did. The read was repeated, which is safe because it is a read.
 *
 * VALID FOR EXACTLY ONE API PROCESS. The marker lives in this process's memory (data.md), so a second API instance would not see the first one's writes. The host
 * runs one instance with a stop-then-start deploy; the startup window covers the old process's last writes. See ARCHITECTURE.md, "What changes in production".
 */
export const READ_YOUR_WRITES_MS = 5_000;

/**
 * What an opted-in read may use: the models and raw reads the three routed endpoints need. Both the plain primary client and the replica client
 * satisfy it, so a service takes one `db` and does not know which database it got.
 */
export type ReadDb = Pick<PrismaClient, 'shift' | 'membership' | '$queryRaw'>;

export type DbRoute = 'primary-required' | 'marker' | 'startup' | 'none' | 'replica-failed';

export interface ReadContext {
  userId: string;
  /** True for a read that must never lag: it goes to the primary whatever the marker says. */
  primaryRequired?: boolean;
  /** Told the route that was used (the request handler puts it on the log line). Called again with `replica-failed` if the replica could not answer. */
  onRoute?: (route: DbRoute) => void;
}

export interface ReadRouting {
  /** Runs `read` against the database this user's read should use. `read` must be a pure read: on a replica failure it is run again on the primary. */
  run<T>(teamId: string, ctx: ReadContext, read: (db: ReadDb) => Promise<T>): Promise<T>;
  /** The decision alone, without running anything. */
  decide(userId: string, primaryRequired?: boolean): Exclude<DbRoute, 'replica-failed'>;
  /** Records that this user just committed a write. Express middleware below does this for every request that can write. */
  markWrite(userId: string): void;
  /** How many users currently hold a marker (tests; the map never holds anyone older than 5 s once swept). */
  markedUsers(): number;
  /** Mount before the routers: records the signed-in user's marker just before the response of any non-safe request is sent. */
  writeMarker: RequestHandler;
  /** Stops the sweep timer. */
  stop(): void;
}

export interface ReadRoutingOptions {
  shards: Shards;
  /** The clock, in milliseconds. Tests pass a fake one. */
  now?: () => number;
  windowMs?: number;
  /** How often expired markers are swept out (no I/O). */
  sweepMs?: number;
  /** Told when the replica could not answer, before the primary is used. Log it with the usual redaction. */
  onReplicaError?: (err: unknown) => void;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createReadRouting(options: ReadRoutingOptions): ReadRouting {
  const { shards, onReplicaError } = options;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? READ_YOUR_WRITES_MS;
  const startedAt = now();
  const markers = new Map<string, number>();

  const hasMarker = (userId: string): boolean => {
    const wroteAt = markers.get(userId);
    if (wroteAt === undefined) return false;
    if (now() - wroteAt >= windowMs) {
      markers.delete(userId); // expired entries are removed when read, and by the sweep
      return false;
    }
    return true;
  };

  function decide(userId: string, primaryRequired = false): Exclude<DbRoute, 'replica-failed'> {
    if (primaryRequired) return 'primary-required';
    if (hasMarker(userId)) return 'marker';
    if (now() - startedAt < windowMs) return 'startup';
    return 'none';
  }

  const sweep = () => {
    const t = now();
    for (const [userId, wroteAt] of markers) if (t - wroteAt >= windowMs) markers.delete(userId);
  };
  const timer = setInterval(sweep, options.sweepMs ?? windowMs);
  timer.unref(); // never keeps the process alive

  async function run<T>(teamId: string, ctx: ReadContext, read: (db: ReadDb) => Promise<T>): Promise<T> {
    const shard = shards[shardFor(teamId)];
    const route = decide(ctx.userId, ctx.primaryRequired);
    // A process without replicas (a script, the worker) reads the primary. The API refuses to start without them (clients.ts).
    if (route !== 'none' || !shard.reader) {
      ctx.onRoute?.(route);
      return read(shard.primary);
    }
    ctx.onRoute?.('none');
    try {
      // At runtime `$replica()` returns the plain replica PrismaClient that was given to the extension; only the extension's declared type is
      // different, and its model delegates do not line up with PrismaClient's. The cast is the whole difference.
      return await read(shard.reader.$replica() as unknown as PrismaClient);
    } catch (err) {
      onReplicaError?.(err);
      ctx.onRoute?.('replica-failed');
      return read(shard.primary);
    }
  }

  const writeMarker: RequestHandler = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    // Marked just before the headers go out, so the marker exists before the client can possibly send its next request. The signed-in user is
    // known by then (the auth middleware sets it); a request that never got that far has no user and wrote nothing as one.
    const writeHead = res.writeHead as (...args: unknown[]) => Response;
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = function patched(this: Response, ...args: unknown[]) {
      const userId: unknown = res.locals.userId;
      if (typeof userId === 'string') markers.set(userId, now());
      return writeHead.apply(this, args);
    };
    next();
  };

  return {
    run,
    decide,
    markWrite: (userId) => void markers.set(userId, now()),
    markedUsers: () => markers.size,
    writeMarker,
    stop: () => clearInterval(timer),
  };
}

/** The context for a read made while answering a request: the route taken goes on the request log as `dbRoute`. */
export function readContext(res: Response, userId: string, primaryRequired = false): ReadContext {
  return {
    userId,
    primaryRequired,
    onRoute: (route) => {
      res.locals.dbRoute = route;
    },
  };
}
