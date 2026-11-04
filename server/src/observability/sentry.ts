import * as Sentry from '@sentry/node';
import type { NodeOptions } from '@sentry/node';
import type { Logger } from '../http/logger.js';
import { createEventGate, fingerprintOf, scrubEvent, type GateDecision } from './sentryScrub.js';

/**
 * Sentry on the server (ADR 0039): ERRORS ONLY, and only what has been through the shared redaction list.
 *
 * - No tracing, profiling, logs or metrics: no sample rate for tracing is set, nothing calls the log or metric APIs, and `beforeSendLog` and `beforeSendMetric` drop
 *   anything that did arrive. Breadcrumbs are off (the structured request log already says what happened).
 * - Everything the SDK would collect by default is switched off (`dataCollection`): the user (we add the id ourselves), cookies, headers, bodies, query strings,
 *   database query data, queue arguments and the values of local variables in stack frames.
 * - Tags go on at the moment of capture, from the failing request's own data, never onto a shared scope: two requests failing at the same time cannot swap request IDs.
 * - What may leave is limited by a gate (shared/sentry-scrub.ts): one event per error per 5 minutes, 10 a minute, 50 a day per process. These numbers are CHOSEN, NOT
 *   MEASURED (Dave, 2026-11-04): the Developer plan's 5,000 errors are shared by the API, the worker and the app.
 * - With no DSN, Sentry is off and nothing is sent. `Sentry.init` is called only from the API's and the worker's `main.ts`, so a test never sends.
 */

type Env = Record<string, string | undefined>;

export interface SentryConfig {
  /** Undefined means Sentry is off. */
  dsn: string | undefined;
  environment: string;
  /**
   * True only for the k6 run (`LOAD_TEST_MODE=true`). While it is on, an error from a request that carries `X-Load-Test: k6` is not sent. While it is off the header is
   * IGNORED: a client can send any header, so honouring it by default would let anyone hide their errors from monitoring.
   */
  loadTestMode: boolean;
  maxPerDay: number;
  maxPerMinute: number;
  dedupeSeconds: number;
}

const DSN_SHAPE = /^https:\/\/[A-Za-z0-9]+(?::[A-Za-z0-9]+)?@[A-Za-z0-9.-]+\/[0-9]+$/;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return Number(raw);
}

export function loadSentryConfig(env: Env = process.env): SentryConfig {
  const rawDsn = env.SENTRY_DSN?.trim();
  // A malformed DSN stops the process at start (a typo at deploy time should be seen at once). The message never shows the value.
  if (rawDsn && !DSN_SHAPE.test(rawDsn)) throw new Error('SENTRY_DSN is not a valid Sentry DSN (https://<key>@<host>/<project id>)');

  const rawLoad = env.LOAD_TEST_MODE?.trim();
  if (rawLoad !== undefined && rawLoad !== '' && rawLoad !== 'true' && rawLoad !== 'false') throw new Error(`LOAD_TEST_MODE must be "true" or "false", got "${rawLoad}"`);

  return {
    dsn: rawDsn || undefined,
    environment: env.SENTRY_ENVIRONMENT?.trim() || 'development',
    loadTestMode: rawLoad === 'true',
    // CHOSEN, NOT MEASURED (Dave, 2026-11-04). 50 a day = 5,000 a month spread over 30 days, divided between the API, the worker and the app.
    maxPerDay: positiveInt(env, 'SENTRY_MAX_EVENTS_PER_DAY', 50),
    maxPerMinute: positiveInt(env, 'SENTRY_MAX_EVENTS_PER_MINUTE', 10),
    dedupeSeconds: positiveInt(env, 'SENTRY_DEDUPE_SECONDS', 300),
  };
}

/** What the failing request or job knows. Everything here becomes a tag, an extra or the user id: nothing else about the request is sent. */
export interface ErrorContext {
  requestId?: string;
  userId?: string;
  teamId?: string;
  /** The route TEMPLATE (`/teams/:teamId/shifts`), never the raw URL. */
  route?: string;
  /** More tags (a job's kind and row, for the worker). Short strings only. */
  tags?: Record<string, string>;
  /** Data that helps and is safe once scrubbed. The scrubber still runs over it. */
  extra?: Record<string, unknown>;
  /** The value of the request's `X-Load-Test` header, read by the caller. It only matters while `LOAD_TEST_MODE` is on. */
  loadTestHeader?: string | undefined;
}

export interface ErrorReporter {
  readonly enabled: boolean;
  /** Reports an unexpected error. Never throws. Returns Sentry's event id when one was queued. */
  captureServerError(error: unknown, context?: ErrorContext): string | undefined;
  flush(timeoutMs?: number): Promise<boolean>;
  close(timeoutMs?: number): Promise<boolean>;
  /** Counts of what the gate and the load-test switch did (for the log and the tests). */
  stats(): Record<GateDecision | 'loadTest', number>;
}

export interface ErrorReporterOptions {
  role: 'api' | 'worker';
  logger?: Logger;
  /** Tests give a transport that keeps the envelopes instead of sending them. */
  transport?: NodeOptions['transport'];
  now?: () => number;
}

const DISABLED: ErrorReporter = {
  enabled: false,
  captureServerError: () => undefined,
  flush: async () => true,
  close: async () => true,
  stats: () => ({ send: 0, duplicate: 0, rate_limited: 0, cap_reached: 0, loadTest: 0 }),
};

export function createErrorReporter(config: SentryConfig, options: ErrorReporterOptions): ErrorReporter {
  if (!config.dsn) return DISABLED;
  const { logger } = options;
  const now = options.now ?? Date.now;
  const counts: Record<GateDecision | 'loadTest', number> = { send: 0, duplicate: 0, rate_limited: 0, cap_reached: 0, loadTest: 0 };
  const gate = createEventGate({
    dedupeMs: config.dedupeSeconds * 1000,
    maxPerMinute: config.maxPerMinute,
    maxTotal: config.maxPerDay,
    totalWindowMs: 24 * 60 * 60 * 1000,
    now,
  });
  const lastLogged = new Map<string, number>();

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    serverName: options.role === 'api' ? 'rota-api' : 'rota-worker',
    // The gate below does the limiting; the SDK's own sampling stays at "everything".
    sampleRate: 1,
    // Errors only: no tracesSampleRate is set, so tracing is off. Anything that is a log or a metric is dropped.
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    maxBreadcrumbs: 0,
    // Switch off everything the SDK collects by default (they are ON by default in version 11).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: (event) => {
      const clean = scrubEvent(event);
      const decision = gate.check(fingerprintOf(clean));
      counts[decision]++;
      if (decision !== 'send') {
        // One line per reason per minute, so a storm does not fill the log with its own warnings.
        const t = now();
        if (t - (lastLogged.get(decision) ?? -Infinity) >= 60_000) {
          lastLogged.set(decision, t);
          logger?.warn('sentry_event_dropped', { reason: decision });
        }
        return null;
      }
      return clean;
    },
    ...(options.transport ? { transport: options.transport } : {}),
  });

  return {
    enabled: true,
    captureServerError(error, context = {}) {
      try {
        if (config.loadTestMode && context.loadTestHeader?.trim().toLowerCase() === 'k6') {
          counts.loadTest++;
          return undefined;
        }
        const tags: Record<string, string> = { role: options.role, ...context.tags };
        if (context.requestId) tags.request_id = context.requestId;
        if (context.teamId) tags.team_id = context.teamId;
        if (context.route) tags.route = context.route;
        return Sentry.captureException(error, {
          tags,
          ...(context.userId ? { user: { id: context.userId } } : {}),
          ...(context.extra ? { extra: context.extra } : {}),
        });
      } catch {
        return undefined; // reporting an error must never become one
      }
    },
    flush: (timeoutMs = 2000) => Sentry.flush(timeoutMs),
    close: (timeoutMs = 2000) => Sentry.close(timeoutMs),
    stats: () => ({ ...counts }),
  };
}
