import { ApiError, OfflineError, StaleAccountError } from '../api/errors';
import { bannerCopy, fieldCopy, PASSWORD_HELPER_MIN } from './copy';
import { formatRetryWait } from './retryWait';

export type AuthScreen = 'login' | 'signup';
export type FieldName = 'name' | 'email' | 'password';
export type FieldErrors = Partial<Record<FieldName, string>>;

/** What a failed sign-in or sign-up looks like on screen. The server's error code decides which; the app only picks words. */
export type AuthFailure =
  | { kind: 'fields'; fields: FieldErrors }
  | { kind: 'credentials' }
  | { kind: 'email_in_use' }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'generic'; message: string; reference: string | null };

interface Detail {
  path: string;
  code: string;
  min?: number;
  max?: number;
}

/** Defensive: `details` crosses the network, so it is checked rather than trusted. */
function readDetails(details: unknown): Detail[] {
  if (!Array.isArray(details)) return [];
  const out: Detail[] = [];
  for (const item of details) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, code, min, max } = item as Record<string, unknown>;
    if (typeof path !== 'string' || typeof code !== 'string') continue;
    out.push({
      path,
      code,
      ...(typeof min === 'number' ? { min } : {}),
      ...(typeof max === 'number' ? { max } : {}),
    });
  }
  return out;
}

function fieldMessage(screen: AuthScreen, detail: Detail): [FieldName, string] | null {
  switch (detail.path) {
    case 'name':
      if (screen !== 'signup') return null;
      return ['name', detail.code === 'too_long' && detail.max !== undefined ? fieldCopy.nameTooLong(detail.max) : fieldCopy.nameRequired];
    case 'email':
      return ['email', fieldCopy.emailInvalid];
    case 'password':
      if (screen === 'login') {
        // Login applies no policy: an empty password is the only short case, and too long can never be right.
        if (detail.code === 'too_long' && detail.max !== undefined) return ['password', fieldCopy.passwordTooLong(detail.max)];
        return ['password', fieldCopy.passwordRequired];
      }
      if (detail.code === 'password_common') return ['password', fieldCopy.passwordCommon];
      if (detail.code === 'too_long' && detail.max !== undefined) return ['password', fieldCopy.passwordTooLong(detail.max)];
      if (detail.code === 'too_short') return ['password', fieldCopy.passwordTooShort(detail.min ?? PASSWORD_HELPER_MIN)];
      return null;
    default:
      return null;
  }
}

const generic = (reference: string | null): AuthFailure => ({ kind: 'generic', message: bannerCopy.generic, reference });

/**
 * Maps whatever a sign-in or sign-up threw to what the screen shows. Returns null for a result that belongs to a
 * previous account (it is thrown away and nothing is shown).
 */
export function describeAuthFailure(screen: AuthScreen, error: unknown): AuthFailure | null {
  if (error instanceof StaleAccountError) return null;
  if (error instanceof OfflineError) return { kind: 'offline', message: bannerCopy.offline };

  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return screen === 'login' ? { kind: 'credentials' } : generic(error.requestId);
      case 'email_in_use':
        return screen === 'signup' ? { kind: 'email_in_use' } : generic(error.requestId);
      case 'rate_limited': {
        const wait = formatRetryWait(error.retryAfterSeconds);
        return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
      }
      case 'validation_failed': {
        const fields: FieldErrors = {};
        for (const detail of readDetails(error.details)) {
          const mapped = fieldMessage(screen, detail);
          if (mapped && fields[mapped[0]] === undefined) fields[mapped[0]] = mapped[1];
        }
        return Object.keys(fields).length > 0 ? { kind: 'fields', fields } : generic(error.requestId);
      }
      default:
        return generic(error.requestId);
    }
  }

  // A timeout, a dropped connection, a failed token save, anything unexpected: no response, so no reference.
  return generic(null);
}
