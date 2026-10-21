import type { RequestHandler } from 'express';

/**
 * Minimal structured logging (ADR 0005, interim). One JSON object per line, UTC ISO 8601 timestamps.
 *
 * Redaction by construction (security.md, observability.md): the logger only accepts the fields named in
 * `ALLOWED`, and only primitive values. There is no way to log a request body, a header, an email, a password
 * or a token by passing it in. The logger library and Sentry arrive at build step 3 and replace this.
 */
const ALLOWED = [
  'requestId',
  'userId',
  'familyId',
  'method',
  'route',
  'status',
  'durationMs',
  'errorCode',
  'dbRoute',
  'outcome',
  'reason',
  'rule',
] as const;
export type LogField = (typeof ALLOWED)[number];
export type LogFields = Partial<Record<LogField, string | number | boolean>>;

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED);
// Bounds one field's size so a long error message can't flood a log line.
const MAX_STRING_LENGTH = 300;

export type LogSink = (line: string) => void;
export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(sink: LogSink = (line) => console.log(line)): Logger {
  function write(level: LogLevel, message: string, fields: LogFields = {}) {
    const entry: Record<string, string | number | boolean> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED_SET.has(key)) continue;
      if (typeof value === 'string') {
        entry[key] = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        entry[key] = value;
      }
    }
    sink(JSON.stringify(entry));
  }
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/**
 * One line per request (observability.md): request ID, user ID when authenticated, the route TEMPLATE (never
 * the raw URL, which could carry a token), status, duration, error code on failure, and the database route.
 * Handlers set `res.locals.userId` and `res.locals.dbRoute`; the error handler sets `res.locals.errorCode`.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.on('close', () => {
      const aborted = !res.writableFinished;
      const template = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : '(unmatched)';
      const status = res.statusCode;
      const fields: LogFields = {
        requestId: String(res.locals.requestId ?? ''),
        method: req.method,
        route: template,
        status,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        outcome: aborted ? 'aborted' : status >= 500 ? 'error' : status >= 400 ? 'rejected' : 'ok',
      };
      if (res.locals.userId) fields.userId = String(res.locals.userId);
      if (res.locals.errorCode) fields.errorCode = String(res.locals.errorCode);
      if (res.locals.dbRoute) fields.dbRoute = String(res.locals.dbRoute);
      const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level]('request', fields);
    });
    next();
  };
}
