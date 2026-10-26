import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { formatRetryWait } from '../auth/retryWait';
import { shiftFormCopy } from './shiftCopy';
import type { ShiftFormErrors } from './shiftForm';

/** What a failed shift call looks like on screen. The server's code decides which; the app only picks words. */
export type ShiftFailure =
  | { kind: 'fields'; fields: ShiftFormErrors }
  | { kind: 'banner'; message: string }
  | { kind: 'gone' }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'generic'; message: string; reference: string | null };

interface Detail {
  path: string;
  code: string;
  max?: number;
}

function readDetails(details: unknown): Detail[] {
  if (!Array.isArray(details)) return [];
  const out: Detail[] = [];
  for (const item of details) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, code, max } = item as Record<string, unknown>;
    if (typeof path === 'string' && typeof code === 'string') out.push({ path, code, ...(typeof max === 'number' ? { max } : {}) });
  }
  return out;
}

/**
 * Maps whatever a create, edit or delete threw to what the screen shows. `shift_overlap` (409) and `not_a_member` are banners, a 404 means the shift is
 * gone, a 403 means the role changed. Returns null when the account changed or the session ended: the screen follows the session status instead.
 */
export function describeShiftFailure(error: unknown): ShiftFailure | null {
  if (error instanceof StaleAccountError || error instanceof SessionEndedError || error instanceof NotSignedInError) return null;
  if (error instanceof OfflineError) return { kind: 'offline', message: bannerCopy.offline };
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'shift_overlap':
        return { kind: 'banner', message: shiftFormCopy.errors.overlap };
      case 'not_found':
        return { kind: 'gone' };
      case 'forbidden':
        return { kind: 'banner', message: shiftFormCopy.errors.forbidden };
      case 'rate_limited': {
        const wait = formatRetryWait(error.retryAfterSeconds);
        return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
      }
      case 'validation_failed': {
        const fields: ShiftFormErrors = {};
        let banner: string | null = null;
        for (const d of readDetails(error.details)) {
          if (d.path === 'title') fields.title = d.code === 'too_long' && d.max !== undefined ? shiftFormCopy.errors.titleTooLong(d.max) : shiftFormCopy.errors.titleRequired;
          else if (d.path === 'endsAt' && d.code === 'must_be_after_start') fields.end = shiftFormCopy.errors.endAfterStart;
          else if (d.path === 'startsAt' || d.path === 'endsAt') fields.start = shiftFormCopy.errors.timeInvalid;
          else if (d.path === 'assignedUserId' && d.code === 'not_a_member') banner = shiftFormCopy.errors.notMember;
        }
        if (Object.keys(fields).length > 0) return { kind: 'fields', fields };
        if (banner) return { kind: 'banner', message: banner };
        return { kind: 'generic', message: bannerCopy.generic, reference: error.requestId };
      }
      default:
        return { kind: 'generic', message: bannerCopy.generic, reference: error.requestId };
    }
  }
  return { kind: 'generic', message: bannerCopy.generic, reference: null };
}
