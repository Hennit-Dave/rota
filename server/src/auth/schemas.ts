import { z } from 'zod';
import type { AuthConfig } from './config.js';
import type { PasswordBlocklist } from './blocklist.js';
import { normalizePassword, passwordLength } from './password.js';
import { REFRESH_TOKEN_PATTERN } from './sessions.js';

/**
 * Request schemas for the auth routes. Built from the config so the limits live in one place. Every object is
 * strict (unknown keys are rejected). Emails are trimmed and lower-cased here, so the unique index on
 * users.email is effectively case-insensitive (the database itself is not, see identity.integration.test.ts).
 */
export function createAuthSchemas(config: AuthConfig, blocklist: PasswordBlocklist) {
  const email = z.string().trim().toLowerCase().pipe(z.email().max(config.email.maxLength));
  const name = z.string().trim().min(1).max(config.name.maxLength);

  // Register: the full policy (NIST SP 800-63B-4). NFC first, then length in code points, then the blocklist.
  const newPassword = z
    .string()
    .transform(normalizePassword)
    .superRefine((password, ctx) => {
      const length = passwordLength(password);
      if (length < config.password.minLength) {
        ctx.addIssue({ code: 'custom', params: { rota: 'too_short', min: config.password.minLength } });
        return;
      }
      if (length > config.password.maxLength) {
        ctx.addIssue({ code: 'custom', params: { rota: 'too_long', max: config.password.maxLength } });
        return;
      }
      if (blocklist.has(password)) {
        ctx.addIssue({ code: 'custom', params: { rota: 'password_common' } });
      }
    });

  // Login: no policy, only "present and not absurdly long". Telling a user their old password is "too short" or
  // "common" would be a hint, and a password can never legitimately be longer than the maximum.
  const existingPassword = z
    .string()
    .transform(normalizePassword)
    .superRefine((password, ctx) => {
      const length = passwordLength(password);
      if (length < 1) ctx.addIssue({ code: 'custom', params: { rota: 'too_short', min: 1 } });
      else if (length > config.password.maxLength) {
        ctx.addIssue({ code: 'custom', params: { rota: 'too_long', max: config.password.maxLength } });
      }
    });

  return {
    register: z.strictObject({ name, email, password: newPassword }),
    login: z.strictObject({ email, password: existingPassword }),
    // The exact shape of a token we issue (32 bytes, base64url), so junk never reaches the database.
    refresh: z.strictObject({ refreshToken: z.string().regex(REFRESH_TOKEN_PATTERN) }),
  };
}
