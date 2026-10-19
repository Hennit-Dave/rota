/**
 * Redacts sensitive credentials, tokens, connection strings, and passwords from error messages and logs.
 * jobs.md / security.md: Safe logging must never leak secrets, passwords, or connection URLs.
 */
export function redactSensitive(input: string | undefined | null): string {
  if (!input) return '';

  return input
    // 1. Redact credentials in URLs (e.g. postgresql://user:pass@host:5432 or rediss://default:secret@host)
    .replace(/([a-zA-Z0-9+.-]+:\/\/)([^:@\s]+)(?::([^@\s]+))?@/g, '$1[REDACTED_USER]:[REDACTED_PASS]@')
    // 2. Redact specific secret token patterns (Resend re_*, Stripe sk_*, Bearer tokens)
    .replace(/(?:sk_live_|sk_test_|re_)[a-zA-Z0-9_]+/g, '[REDACTED_SECRET]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]')
    // 3. Redact query param or key-value style credentials (password=..., secret=..., token=..., apiKey=...)
    .replace(/([?&;](?:password|passwd|secret|token|api_key|apikey)=)[^&\s;]+/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|secret|token|apiKey)\s*[:=]\s*['"]?)[^'"\s,;]+/gi, '$1[REDACTED]');
}

export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    return redactSensitive(err.message);
  }
  if (typeof err === 'string') {
    return redactSensitive(err);
  }
  return redactSensitive(String(err));
}

export function formatWorkerInitError(err: unknown): string {
  return `worker failed to initialize valkey connection: ${sanitizeError(err)}`;
}

export function formatWorkerError(err: unknown): string {
  return `worker error: ${sanitizeError(err)}`;
}

export function formatJobFailedLog(jobId: string | undefined, err: unknown): string {
  return `job ${jobId ?? 'unknown'} failed: ${sanitizeError(err)}`;
}

export function formatCheckValkeyError(err: unknown): string {
  return `Valkey check failed: ${sanitizeError(err)}`;
}
