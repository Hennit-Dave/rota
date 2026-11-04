/**
 * ONE redaction list for Sentry, on the server and in the app (observability.md, ADR 0039).
 *
 * This is the canonical copy. It is plain TypeScript with no imports, so the same bytes work in both packages, and it is copied byte for byte to
 *   server/src/observability/sentryScrub.ts   and   app/src/observability/sentryScrub.ts
 * with `node shared/sync-sentry-scrub.mjs`. A test in each package fails if its copy differs from this file, so the two lists cannot drift.
 *
 * What it does, in plain words: before an error leaves the machine, every string and every key is checked against the list below. A key whose name suggests a secret
 * (a token, a password, an email, a card, an Authorization header...) has its value replaced, and a string that looks like a secret (a bearer token, a JWT, an invite
 * token, an email address, a card number, a Stripe key or id, a password in a URL...) has that part replaced. The user is cut down to an id, the request is
 * removed, and breadcrumbs lose their console lines and their URL query strings. It also holds the gate that limits how many events leave (the Developer plan has a small
 * monthly quota). Nothing here sends anything.
 */

export const REDACTED = '[redacted]';

const MAX_DEPTH = 8;

/**
 * A key is sensitive when its name (lower case, letters and digits only) CONTAINS one of these. So `Authorization`, `x-api-key`, `accessToken`, `expoPushToken`,
 * `stripe-signature`, `newPassword`, `cardNumber`, `emailAddress` and `client_secret` all match. Cards and payments: the whole object is replaced, not just a number.
 */
export const SENSITIVE_KEY_PARTS: readonly string[] = [
  'authorization',
  'cookie',
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'apikey',
  'signature',
  'jwt',
  'bearer',
  'credential',
  'privatekey',
  'accesskey',
  'email',
  'cardnumber',
  'cardbrand',
  'last4',
  'expmonth',
  'expyear',
  'cvc',
  'cvv',
  'paymentmethod',
  'paymentintent',
  'amountcents',
];

/** Short names that must match exactly (a substring test would hit unrelated words). */
export const SENSITIVE_KEYS_EXACT: readonly string[] = ['card', 'pan', 'otp', 'amount'];

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS_EXACT.includes(k) || SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

/** Luhn check: used so a long run of digits is only called a card number when it could be one (an epoch time in a message is usually not). */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Patterns for text that looks like a secret, applied in this order. Each match is replaced by REDACTED (or, where noted, only the secret part). */
const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // A password in a URL: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, `$1${REDACTED}@`],
  // The token in an invite, magic-link or reset URL path: /invite/<token>
  [/(\/(?:invite|magic|reset)\/)[^\s/?#"')]+/gi, `$1${REDACTED}`],
  // Any URL that appears INSIDE text (a message, a note, a breadcrumb line) loses its query string and fragment, not only a field that holds a URL: `https://host/path?x=1#top`
  // and `/teams/:teamId/shifts?from=...` both lose everything from the "?". A "?" at the end of a sentence is left alone (it needs a URL or a path in front of it).
  [/(https?:\/\/[^\s?#"')]+|(?<![\w:/])\/[A-Za-z0-9_\-.~%:@+,;=/[\]]+)\?[^\s"')]*/g, '$1'],
  // A secret in a query string that is NOT part of a URL: ?token=..., &code=..., &password=...
  [/([?&][A-Za-z0-9_]*(?:token|secret|password|passwd|key|sig|signature|code|auth)[A-Za-z0-9_]*=)[^&\s#"')]+/gi, `$1${REDACTED}`],
  // Authorization headers and bearer tokens
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, REDACTED],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // An invite token: <teamId>.<43 characters>
  [/(?<![A-Za-z0-9_-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, REDACTED],
  // Stripe: a client secret (pi_..._secret_...), secret and webhook keys, and object ids (payment data)
  [/\b[a-z]{2,5}_[A-Za-z0-9]{6,}_secret_[A-Za-z0-9_-]+/g, REDACTED],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]+/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9_-]+/g, REDACTED],
  [/\b(?:pi|pm|cus|cs|seti|evt|ch|py|tok)_[A-Za-z0-9_-]{12,}/g, REDACTED],
  // A Resend API key
  [/\bre_[A-Za-z0-9_-]{16,}/g, REDACTED],
  // An email address
  [/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, REDACTED],
  // A card number: 13 to 19 digits, spaces or dashes allowed between them, and it must pass the Luhn check
  [/\b\d(?:[ -]?\d){12,18}\b/g, (match: string) => (passesLuhn(match.replace(/[ -]/g, '')) ? REDACTED : match)],
];

export function scrubString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/** A URL or route with its query string and fragment removed (a link can carry a token there), and any token in its path or credentials replaced. */
export function scrubUrl(url: string): string {
  return scrubString(url.replace(/[?#].*$/, ''));
}

// Keys that hold a URL or a route, so they get `scrubUrl` (the query string goes) and not only `scrubString`.
const URL_KEYS = new Set(['url', 'to', 'from', 'href', 'uri', 'path', 'pathname', 'route', 'target']);

/** Walks any value: strings are scrubbed, values under a sensitive key are replaced, and anything deeper than 8 levels is cut. Returns a copy; the input is not changed. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) out[key] = REDACTED;
    else if (typeof v === 'string' && URL_KEYS.has(key.toLowerCase())) out[key] = scrubUrl(v);
    else out[key] = scrubValue(v, depth + 1);
  }
  return out;
}

/** The parts of a Sentry event or breadcrumb this file touches (a loose shape, so each SDK's own types are assignable to it). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

/** Breadcrumbs: console lines are dropped (they are free text, and the structured logs already exist); the rest lose secrets, and URLs lose their query strings. */
export function scrubBreadcrumb<B extends object>(breadcrumb: B): B | null {
  const b = breadcrumb as Loose;
  if (b.category === 'console') return null;
  const out: Loose = { ...b };
  if (typeof out.message === 'string') out.message = scrubString(out.message);
  if (out.data && typeof out.data === 'object') out.data = scrubValue(out.data);
  return out as B;
}

/**
 * The address EVERY event carries in `user.ip_address`, whatever it was sent with (a real address, `null`, `{{auto}}`, nothing): never a real one. Sentry works out a
 * user's GEOGRAPHY (city, country) from the address it infers for the event, even when "Prevent Storing of IP Addresses" is on (docs.sentry.io/security-legal-pii/scrubbing/
 * server-side-scrubbing, "Geographic Information"), and its docs name no SDK value that stops it. Tried on real events (ADR 0039): with no `ip_address` or with `null` the
 * geography still appeared on a server and an app event; with this placeholder it did not. The project's own rule `[Remove] [Anything] from [$user.geo.**]` is a second layer
 * for events this code never sees (a hard native crash in the app).
 */
export const ANONYMOUS_IP = '0.0.0.0';

/** The `device` context keys that help debugging (model, memory, the kind of device). Everything else in it (the device id, battery, storage, boot time, time zone...) is dropped. */
export const DEVICE_CONTEXT_KEEP: readonly string[] = ['model', 'model_id', 'family', 'manufacturer', 'brand', 'simulator', 'arch', 'memory_size'];

/** Keys dropped from the `app` context: a stable per-install hash identifies one installation as surely as a device id does. */
export const APP_CONTEXT_DROP: readonly string[] = ['device_app_hash'];

/**
 * Cuts an error event down to what is safe to send:
 *  - `user`: only the id (never an email, username or geography), plus `ip_address` set to `ANONYMOUS_IP` on every event, with or without a user (see above);
 *  - `contexts`: `culture` (locale and time zone) is removed, `device` keeps only `DEVICE_CONTEXT_KEEP`, and `app` loses its per-install hash;
 *  - `request`: removed (URL, headers, cookies, body and query string can all hold secrets); the route template and ids travel as tags;
 *  - exception messages, the message, extra data, contexts, tags and breadcrumbs: scrubbed with the list above;
 *  - stack frames: variable values removed (only the file, function and line stay).
 * Returns a new object; the input is not changed.
 */
export function scrubEvent<E extends object>(event: E): E {
  const e: Loose = { ...(event as Loose) };

  const id = e.user?.id;
  const hasId = id !== undefined && id !== null && id !== '';
  e.user = { ...(hasId ? { id: String(id) } : {}), ip_address: ANONYMOUS_IP };
  delete e.request;

  if (typeof e.message === 'string') e.message = scrubString(e.message);
  if (e.logentry && typeof e.logentry.message === 'string') e.logentry = { ...e.logentry, message: scrubString(e.logentry.message), params: undefined };

  if (e.exception?.values) {
    e.exception = {
      ...e.exception,
      values: e.exception.values.map((v: Loose) => ({
        ...v,
        value: typeof v.value === 'string' ? scrubString(v.value) : v.value,
        stacktrace: v.stacktrace
          ? { ...v.stacktrace, frames: (v.stacktrace.frames ?? []).map((f: Loose) => ({ ...f, vars: undefined, pre_context: undefined, post_context: undefined, context_line: undefined })) }
          : v.stacktrace,
      })),
    };
  }

  if (e.extra) e.extra = scrubValue(e.extra);
  if (e.contexts) {
    const contexts = scrubValue(e.contexts) as Loose;
    delete contexts.culture;
    if (contexts.device && typeof contexts.device === 'object') {
      contexts.device = Object.fromEntries(Object.entries(contexts.device as Loose).filter(([key]) => DEVICE_CONTEXT_KEEP.includes(key)));
    }
    if (contexts.app && typeof contexts.app === 'object') {
      contexts.app = Object.fromEntries(Object.entries(contexts.app as Loose).filter(([key]) => !APP_CONTEXT_DROP.includes(key)));
    }
    // A context that ended up empty (the SDK's own switches leave `{}` behind) is removed, so Sentry shows no empty panel.
    for (const key of Object.keys(contexts)) {
      const c = contexts[key];
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) delete contexts[key];
    }
    e.contexts = contexts;
  }
  if (e.tags) e.tags = scrubValue(e.tags);
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = e.breadcrumbs.map((b: Loose) => scrubBreadcrumb(b)).filter((b: Loose | null) => b !== null);
  }
  return e as E;
}

/** A short key that says "the same error": the type, the top stack frame, and the message with numbers and ids taken out. Used to send one event per error per few minutes. */
export function fingerprintOf(event: object): string {
  const e = event as Loose;
  const first = e.exception?.values?.[0] ?? {};
  const frames: Loose[] = first.stacktrace?.frames ?? [];
  const top = frames[frames.length - 1];
  const where = top ? `${top.filename ?? ''}:${top.function ?? ''}` : '';
  const text = String(first.value ?? e.message ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '#')
    .slice(0, 120);
  return `${first.type ?? 'Error'}|${where}|${text}`;
}

export type GateDecision = 'send' | 'duplicate' | 'rate_limited' | 'cap_reached';

export interface EventGateOptions {
  /** The same error (same fingerprint) is sent at most once in this many milliseconds. */
  dedupeMs: number;
  /** At most this many events in any 60 seconds. */
  maxPerMinute: number;
  /** At most this many events in `totalWindowMs`. */
  maxTotal: number;
  /** The window `maxTotal` counts over: 24 hours for a server process, `Infinity` for one app session. */
  totalWindowMs: number;
  now?: () => number;
}

/**
 * The limit on what leaves the machine (the Developer plan's quota is small and shared by the API, the worker and the app). `check` answers whether an event may be sent
 * and, when it says `send`, counts it. A duplicate is turned away first, so it never uses up the budget.
 */
export function createEventGate(options: EventGateOptions): { check(fingerprint: string): GateDecision } {
  const now = options.now ?? Date.now;
  const sent: number[] = [];
  const lastByFingerprint = new Map<string, number>();
  return {
    check(fingerprint) {
      const t = now();
      const last = lastByFingerprint.get(fingerprint);
      if (last !== undefined && t - last < options.dedupeMs) return 'duplicate';
      if (Number.isFinite(options.totalWindowMs)) {
        while (sent.length > 0 && t - (sent[0] as number) >= options.totalWindowMs) sent.shift();
      }
      if (sent.length >= options.maxTotal) return 'cap_reached';
      let inLastMinute = 0;
      for (let i = sent.length - 1; i >= 0 && t - (sent[i] as number) < 60_000; i--) inLastMinute++;
      if (inLastMinute >= options.maxPerMinute) return 'rate_limited';
      sent.push(t);
      lastByFingerprint.set(fingerprint, t);
      if (lastByFingerprint.size > 500) {
        for (const [fp, at] of lastByFingerprint) if (t - at >= options.dedupeMs) lastByFingerprint.delete(fp);
      }
      return 'send';
    },
  };
}
