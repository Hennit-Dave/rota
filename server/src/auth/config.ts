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
  /** How long an emailed magic-link token lasts. */
  magicLinkMinutes: number;
  /** How long an emailed password-reset token lasts. */
  passwordResetMinutes: number;
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
    feedUser: RateRuleConfig;
    swapRequestUser: RateRuleConfig;
    inviteSendUser: RateRuleConfig;
    inviteSendTeam: RateRuleConfig;
    invitePreviewIp: RateRuleConfig;
    inviteAcceptUser: RateRuleConfig;
    inviteAcceptIp: RateRuleConfig;
    magicRequestIp: RateRuleConfig;
    magicRequestEmail: RateRuleConfig;
    magicRedeemIp: RateRuleConfig;
    resetRequestIp: RateRuleConfig;
    resetRequestEmail: RateRuleConfig;
    resetSubmitIp: RateRuleConfig;
  };
  recovery: {
    /** App-wide cap on reset and magic-link emails per UTC day, counted only for requests that will really send one. */
    globalDailyCap: number;
  };
  invites: {
    /** How long an invitation (and its link) lasts, counted from create or resend. */
    expiryDays: number;
    /** App-wide cap on invite emails per UTC day (a count, not a window: the window is the UTC day). */
    globalDailyCap: number;
    /** https origin of the App Link host. The link is `<base>/invite/<teamId>.<secret>`. */
    linkBaseUrl: string;
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
    // 10 minutes (Dave, 2026-10-26, ADR 0020): NIST SP 800-63B-4 requires an out-of-band authentication to complete within 10 minutes.
    magicLinkMinutes: positiveInt(env, 'AUTH_MAGIC_LINK_MINUTES', 10),
    // 1 hour (Dave, 2026-10-26, ADR 0020): our judgment, below NIST SP 800-63B-4's 24-hour ceiling for a recovery code sent by email. OWASP gives
    // no number ("an appropriate period").
    passwordResetMinutes: positiveInt(env, 'AUTH_PASSWORD_RESET_MINUTES', 60),
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
      // Approved by Dave 2026-10-26 (activity feed, ADR 0022): 120 per minute per user. CHOSEN, NOT MEASURED; the load test (200 distinct users) checks it.
      feedUser: rule(env, 'RATE_LIMIT_FEED_USER', { max: 120, windowSeconds: 60 }),
      // Approved by Dave 2026-10-27 (swaps, ADR 0023): 10 swap requests per user per hour. CHOSEN, NOT MEASURED.
      swapRequestUser: rule(env, 'RATE_LIMIT_SWAP_REQUEST_USER', { max: 10, windowSeconds: 3600 }),
      // Approved by Dave 2026-10-23 (Invites plan). Unauthenticated preview and accept reuse the login-IP baseline (30 per 15 minutes);
      // the token's entropy is the security, these only bound abuse.
      inviteSendUser: rule(env, 'RATE_LIMIT_INVITE_SEND_USER', { max: 10, windowSeconds: 3600 }),
      inviteSendTeam: rule(env, 'RATE_LIMIT_INVITE_SEND_TEAM', { max: 20, windowSeconds: 86_400 }),
      invitePreviewIp: rule(env, 'RATE_LIMIT_INVITE_PREVIEW_IP', { max: 30, windowSeconds: 900 }),
      inviteAcceptUser: rule(env, 'RATE_LIMIT_INVITE_ACCEPT_USER', { max: 10, windowSeconds: 3600 }),
      inviteAcceptIp: rule(env, 'RATE_LIMIT_INVITE_ACCEPT_IP', { max: 30, windowSeconds: 900 }),
      // Approved by Dave 2026-10-26 (slice 2b, ADR 0020): they mirror the login rules. A request is limited per IP (30 per 15 minutes) and per
      // email (5 per 15 minutes, counted whether or not the address has an account, so a 429 reveals nothing); redeeming a magic link and
      // submitting a reset are limited per IP (30 per 15 minutes).
      magicRequestIp: rule(env, 'RATE_LIMIT_MAGIC_REQUEST_IP', { max: 30, windowSeconds: 900 }),
      magicRequestEmail: rule(env, 'RATE_LIMIT_MAGIC_REQUEST_EMAIL', { max: 5, windowSeconds: 900 }),
      magicRedeemIp: rule(env, 'RATE_LIMIT_MAGIC_REDEEM_IP', { max: 30, windowSeconds: 900 }),
      resetRequestIp: rule(env, 'RATE_LIMIT_RESET_REQUEST_IP', { max: 30, windowSeconds: 900 }),
      resetRequestEmail: rule(env, 'RATE_LIMIT_RESET_REQUEST_EMAIL', { max: 5, windowSeconds: 900 }),
      resetSubmitIp: rule(env, 'RATE_LIMIT_RESET_SUBMIT_IP', { max: 30, windowSeconds: 900 }),
    },
    recovery: {
      // 30 per UTC day (Dave, 2026-10-26, ADR 0020): Resend's free plan sends 100 emails per UTC day in total and invitations keep 50 of them (ADR 0015).
      globalDailyCap: positiveInt(env, 'AUTH_EMAIL_GLOBAL_DAILY_CAP', 30),
    },
    invites: {
      // 7 days (Dave, 2026-10-23, ADR 0015): long enough for a shift worker who checks email every few days, short enough for a token that
      // grants team access (and is tied to one email address).
      expiryDays: positiveInt(env, 'INVITE_EXPIRY_DAYS', 7),
      // 50 per UTC day (Dave, 2026-10-23, ADR 0015): Resend's free plan sends 100 emails per UTC day in total; half is kept for reset,
      // magic link (slice 2b) and proofs.
      globalDailyCap: positiveInt(env, 'INVITE_GLOBAL_DAILY_CAP', 50),
      linkBaseUrl: linkBaseUrl(env),
    },
  };
}

function linkBaseUrl(env: Env): string {
  const raw = env.INVITE_LINK_BASE_URL;
  const value = raw === undefined || raw === '' ? 'https://rota.davebuilds.design' : raw;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVITE_LINK_BASE_URL must be an absolute https URL.');
  }
  // An App Link is https only, and the link carries a token: never plain http, never a path or query of its own.
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('INVITE_LINK_BASE_URL must be an https origin with no path, query or credentials.');
  }
  return url.origin;
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
