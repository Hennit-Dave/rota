/**
 * Authentication settings (security.md: lifetimes, expiries and thresholds are config chosen in an ADR,
 * never invented in code). Every default below was approved by Dave on 2026-10-21 (PR A plan; ADR 0005,
 * ADR 0007). An env var overrides a default; an env var that is set but not a positive integer is an
 * error, not silently ignored: a typo in a security setting must stop the server, not weaken it.
 */

export interface RateRuleConfig {
  max: number;
  windowSeconds: number;
}

export interface AuthConfig {
  accessTokenMinutes: number;
  refreshIdleDays: number;
  sessionAbsoluteDays: number;
  /** 0: the same process issues and verifies, so there is no cross-host skew (ADR 0005). */
  clockSkewSeconds: number;
  /**
   * How long an auth transaction may wait to START (Prisma's `maxWait`; its default is 2000). 5000 covers the cold
   * Neon connection measured from the development machine (3.7 s for a first query). Measured locally only:
   * re-measure on the deployment host (ADR 0005).
   */
  transactionMaxWaitMs: number;
  issuer: string;
  audience: string;
  password: { minLength: number; maxLength: number };
  email: { maxLength: number };
  name: { maxLength: number };
  rateLimits: {
    loginIp: RateRuleConfig;
    loginEmail: RateRuleConfig;
    registerIp: RateRuleConfig;
    refreshIp: RateRuleConfig;
    teamCreateUser: RateRuleConfig;
  };
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is too large`);
  return n;
}

function rule(env: Env, prefix: string, defaults: RateRuleConfig): RateRuleConfig {
  return {
    max: positiveInt(env, `${prefix}_MAX`, defaults.max),
    windowSeconds: positiveInt(env, `${prefix}_WINDOW_SECONDS`, defaults.windowSeconds),
  };
}

export function loadAuthConfig(env: Env = process.env): AuthConfig {
  return {
    accessTokenMinutes: positiveInt(env, 'AUTH_ACCESS_TOKEN_MINUTES', 15),
    refreshIdleDays: positiveInt(env, 'AUTH_REFRESH_IDLE_DAYS', 30),
    sessionAbsoluteDays: positiveInt(env, 'AUTH_SESSION_ABSOLUTE_DAYS', 90),
    clockSkewSeconds: 0,
    transactionMaxWaitMs: positiveInt(env, 'AUTH_TRANSACTION_MAX_WAIT_MS', 5000),
    issuer: 'rota-api',
    audience: 'rota-app',
    // 15: NIST SP 800-63B-4 section 3.1.1.2 for a password used alone. 128: our cap, above the 64 NIST asks
    // verifiers to permit; it only bounds request size. No composition rules (NIST: SHALL NOT impose them).
    password: { minLength: 15, maxLength: 128 },
    // 254: the longest valid email address (RFC 5321 path limit minus the angle brackets).
    email: { maxLength: 254 },
    // Our cap on a display name; it only bounds request size.
    name: { maxLength: 100 },
    rateLimits: {
      loginIp: rule(env, 'RATE_LIMIT_LOGIN_IP', { max: 30, windowSeconds: 900 }),
      loginEmail: rule(env, 'RATE_LIMIT_LOGIN_EMAIL', { max: 5, windowSeconds: 900 }),
      registerIp: rule(env, 'RATE_LIMIT_REGISTER_IP', { max: 10, windowSeconds: 3600 }),
      refreshIp: rule(env, 'RATE_LIMIT_REFRESH_IP', { max: 60, windowSeconds: 900 }),
      // Approved by Dave 2026-10-23 (Teams and roles plan): 5 new teams per user per hour.
      teamCreateUser: rule(env, 'RATE_LIMIT_TEAM_CREATE_USER', { max: 5, windowSeconds: 3600 }),
    },
  };
}

// RFC 7518 section 3.2: an HS256 key must be at least as large as the hash output, 256 bits = 32 bytes.
const MIN_JWT_SECRET_BYTES = 32;

/**
 * AUTH_JWT_SECRET is base64 of at least 32 random bytes (`openssl rand -base64 32`). The server refuses to
 * start without it. The raw bytes are the HMAC key. The value is never logged.
 */
export function loadJwtSecret(env: Env = process.env): Uint8Array {
  const raw = env.AUTH_JWT_SECRET;
  if (!raw) throw new Error('AUTH_JWT_SECRET is not set.');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    throw new Error('AUTH_JWT_SECRET must be base64 (generate one with: openssl rand -base64 32).');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length < MIN_JWT_SECRET_BYTES) {
    throw new Error(
      `AUTH_JWT_SECRET must decode to at least ${MIN_JWT_SECRET_BYTES} bytes (HS256, RFC 7518 section 3.2).`,
    );
  }
  return new Uint8Array(bytes);
}
