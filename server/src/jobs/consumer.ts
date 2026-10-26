import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { BULLMQ_STALLED_INTERVAL_MS, PRODUCER_COMMAND_TIMEOUT_MS } from './config.js';
import { createWorkerConnection } from './connection.js';

// The worker's consumer and its watchdog (issue #39, ADR 0018).
//
// In plain words: BullMQ's worker waits on Valkey with a blocking command. If the connection dies quietly (a laptop sleeps, a NAT
// forgets the mapping), nothing is ever sent back, so the wait never ends, nothing fails and nothing reconnects: the worker sits there
// taking no jobs until someone restarts it. The producer side fixes this by noticing a command timeout (recycleIfStale); the consumer
// has no command that times out, so it needs a probe of its own.

/** A worker and the connection it was built on. BullMQ duplicates this connection for its blocking commands; both go over the same path. */
export interface Consumer {
  worker: Worker;
  connection: Redis;
}

export interface CreateConsumerOptions {
  /** Defaults to VALKEY_URL. Tests pass a local address; never the shared instance. */
  url?: string;
  /** Builds the BullMQ worker on the given connection (production passes createWorkWorker). */
  makeWorker: (connection: Redis) => Worker;
  /** Attaches event handlers (ready, error, failed, completed) to every worker that gets built, including rebuilt ones. */
  attach?: (worker: Worker) => void;
}

/**
 * Build a consumer: a fresh worker connection and a worker on it. The connection is started in the background, not awaited: a rebuild
 * happens when the network may still be down, and ioredis keeps retrying with its own strategy until it is not.
 */
export function createConsumer(options: CreateConsumerOptions): Consumer {
  const connection = createWorkerConnection(options.url);
  void connection.connect().catch(() => {
    // Reported through the worker's 'error' event; ioredis keeps retrying.
  });
  const worker = options.makeWorker(connection);
  options.attach?.(worker);
  return { worker, connection };
}

export interface ConsumerWatchdogOptions {
  consumer: Consumer;
  /** Builds a replacement consumer (createConsumer, with the same handlers). */
  rebuild: () => Consumer;
  /** Probe period. Defaults to BULLMQ_STALLED_INTERVAL_MS, the 15 s already approved in ADR 0003: no new setting. Tests shorten it. */
  intervalMs?: number;
  /** How long a probe, and the teardown of the old consumer, may take. Defaults to PRODUCER_COMMAND_TIMEOUT_MS (2 s, ADR 0003). */
  timeoutMs?: number;
}

export type ProbeOutcome =
  | 'ok'
  | 'rebuilt'
  | 'skipped_busy' // another probe or rebuild is still in progress (the guard)
  | 'skipped_not_ready' // ioredis already knows the connection is down and is reconnecting by itself
  | 'skipped_connecting' // TCP is up and ioredis is still doing its handshake; seen once, not yet suspicious
  | 'skipped_stopped'
  | 'probe_error'; // the probe failed with an answer, not silence: not the half-open case

export interface ConsumerWatchdog {
  /** The consumer in use now. It changes after a rebuild, so shutdown must ask here. */
  current(): Consumer;
  /** Run one probe now (the timer calls this). Resolves with what happened. */
  probeNow(): Promise<ProbeOutcome>;
  /** Stop probing and wait for a probe or rebuild already in progress. Does not close the consumer. */
  stop(): Promise<void>;
}

class ProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`no reply to PING within ${ms}ms`);
    this.name = 'ProbeTimeoutError';
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(ms)), ms);
    timer.unref?.();
  });
  // A late settlement of the abandoned work must not become an unhandled rejection.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Watch the consumer's connection and rebuild the consumer when it has gone silent.
 *
 * Every `intervalMs` a PING goes over the worker's own connection with a `timeoutMs` limit. Silence while ioredis still says `ready`
 * is the half-open case: the whole consumer (connection and worker, so BullMQ's blocking connection too) is replaced. A connection
 * that is not `ready` is left to ioredis, and a PING answered with an error is not silence, so neither triggers a rebuild.
 *
 * One more silent state needs the same treatment. ioredis 5.11 sends `CLIENT SETINFO` when a connection opens and only then calls it
 * `ready`. A connection opened while the path still swallows traffic (the rebuild itself can run in that window) gets its TCP
 * connection accepted but no reply, and the worker's connection has no command timeout, so it sits in `connect` for ever. A normal
 * handshake takes milliseconds, so the same connection found in `connect` on two probes in a row (a full interval apart) is treated
 * as silence too. No new number: it reuses the probe interval.
 *
 * **Guard: a rebuild never starts while another is in progress.** One flag covers the probe, the build and the bounded teardown of
 * the old consumer; a tick that finds it set does nothing. Probes never overlap either.
 *
 * The old worker is closed with `close(true)` (it does not wait for the job it is running), bounded by `timeoutMs`, and its
 * connection is then disconnected hard. A job that was running at that moment is recovered by BullMQ's stalled-job check and our claim
 * lease (jobs.md); an email would be protected by its idempotency key.
 */
export function startConsumerWatchdog(options: ConsumerWatchdogOptions): ConsumerWatchdog {
  const intervalMs = options.intervalMs ?? BULLMQ_STALLED_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? PRODUCER_COMMAND_TIMEOUT_MS;
  let current = options.consumer;
  let seenConnecting: Redis | null = null; // the connection found in `connect` on the previous probe
  let busy = false;
  let stopped = false;
  const running = new Set<Promise<ProbeOutcome>>();

  async function retire(old: Consumer): Promise<void> {
    try {
      await withTimeout(old.worker.close(true), timeoutMs);
    } catch {
      // A dead connection may never finish closing; the hard disconnect below is what releases it.
    }
    old.connection.disconnect();
  }

  async function probe(): Promise<ProbeOutcome> {
    if (stopped) return 'skipped_stopped';
    if (busy) return 'skipped_busy'; // checked and set with no await in between, so two ticks can never both pass
    busy = true;
    try {
      const connection = current.connection;
      let reason = 'no_reply_to_ping';
      if (connection.status === 'connect') {
        if (seenConnecting !== connection) {
          seenConnecting = connection;
          return 'skipped_connecting';
        }
        reason = 'handshake_never_finished';
      } else {
        seenConnecting = null;
        if (connection.status !== 'ready') return 'skipped_not_ready';
        try {
          await withTimeout(connection.ping(), timeoutMs);
          return 'ok';
        } catch (err) {
          if (!(err instanceof ProbeTimeoutError)) {
            console.warn(`[worker:consumer_probe_error] ${err instanceof Error ? err.message : 'unknown error'}`);
            return 'probe_error';
          }
        }
      }
      seenConnecting = null;
      console.warn(`[worker:consumer_rebuild] reason=${reason}`);
      const old = current;
      current = options.rebuild();
      await retire(old);
      return 'rebuilt';
    } finally {
      busy = false;
    }
  }

  const probeNow = () => {
    const run = probe();
    running.add(run);
    const forget = () => void running.delete(run);
    run.then(forget, forget);
    return run;
  };

  const timer = setInterval(() => void probeNow(), intervalMs);
  timer.unref?.();

  return {
    current: () => current,
    probeNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...running]);
    },
  };
}
