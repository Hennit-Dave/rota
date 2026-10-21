# Security

Status: **partial**, written as PR A (server authentication) lands. The eight-threat list (brief, Requirement 4) is
completed in later slices; sections below are added by the slice that builds the control.

## Rate limiting (threat 5: credential stuffing and brute force)

Held in Valkey, never in memory (ADR 0007). Fixed windows, keyed by a hash of the IP or the email.

| Rule | Limit | Window | Env override (max / window seconds) |
|---|---|---|---|
| `login_ip` | 30 | 15 minutes | `RATE_LIMIT_LOGIN_IP_MAX` / `_WINDOW_SECONDS` |
| `login_email` | 5 | 15 minutes | `RATE_LIMIT_LOGIN_EMAIL_MAX` / `_WINDOW_SECONDS` |
| `register_ip` | 10 | 1 hour | `RATE_LIMIT_REGISTER_IP_MAX` / `_WINDOW_SECONDS` |
| `refresh_ip` | 60 | 15 minutes | `RATE_LIMIT_REFRESH_IP_MAX` / `_WINDOW_SECONDS` |

- A blocked request is `429 rate_limited` with a `Retry-After` header, and never reaches password verification.
- If Valkey is unreachable or rejects the write, these routes answer `503 service_unavailable` (fail closed).
- The IP is the TCP peer address. `X-Forwarded-For` is not trusted until the host's proxy setup is verified.
- A set-but-invalid override (not a positive integer) stops the server from starting.

## Request IDs and logging

- Every response carries `X-Request-Id`. An incoming one is accepted only if it is a canonical UUID; otherwise a new one is made.
- One JSON log line per request: request ID, user ID (when authenticated), route **template**, status, duration, error code,
  database route. UTC ISO 8601 timestamps.
- The logger only accepts a fixed list of fields and primitive values. It cannot be handed a request body, a header, an
  email, a password or a token, so none of them can reach a log line. Error text passes through the shared redaction.
- This is the minimum. The logger library and Sentry are chosen at build step 3.

## Passwords (threat 5, with rate limiting)

- Stored as Argon2id (19 MiB, 2 iterations, parallelism 1) on shard A, in `credentials.password_hash`. Never returned, never
  logged. Library and benchmark: ADR 0006.
- Policy (NIST SP 800-63B-4, ADR 0005): minimum 15 and maximum 128 characters, counted as Unicode code points; NFC-normalised;
  no composition rules; over-long passwords are rejected, never truncated. A blocklist check exists but **its list is empty:
  NIST SHALL not yet met, no list with a confirmed data licence** (ADR 0005; tracked in `AGENTS.md`, "Later proofs").
- Login never says which of email or password was wrong: one `401 invalid_credentials`, and an unknown email still runs one
  Argon2 verification against a dummy hash so timing does not reveal accounts.
- **Accepted trade-off: `409 email_in_use` at sign-up reveals that an address has an account.** Sign-up verification is deferred,
  so there is no way to answer identically. The route is rate limited. **Squatting risk until magic link / verification
  lands:** anyone can register someone else's address (unverified) and hold the account.

## Signing secret

`AUTH_JWT_SECRET` is base64 of at least 32 random bytes (RFC 7518 section 3.2). Generate: `openssl rand -base64 32`.
The server refuses to start without it. Rotation and the rest of the token section are written in PR A stage 3.
