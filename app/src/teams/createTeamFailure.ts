import { ApiError, OfflineError, StaleAccountError } from '../api/errors';
import { bannerCopy, createTeamCopy } from '../auth/copy';
import { formatRetryWait } from '../auth/retryWait';
import type { CreateTeamFieldErrors } from './createTeamValidation';

/** What a failed "Create team" looks like. The server's error code decides which; the app only picks words. */
export type CreateTeamFailure =
  | { kind: 'fields'; fields: CreateTeamFieldErrors }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'generic'; message: string; reference: string | null };

const generic = (reference: string | null): CreateTeamFailure => ({ kind: 'generic', message: bannerCopy.generic, reference });

/** Defensive: `details` crosses the network, so it is checked rather than trusted. */
export function readDetails(details: unknown): Array<{ path: string; code: string; max?: number }> {
  if (!Array.isArray(details)) return [];
  const out: Array<{ path: string; code: string; max?: number }> = [];
  for (const item of details) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, code, max } = item as Record<string, unknown>;
    if (typeof path !== 'string' || typeof code !== 'string') continue;
    out.push({ path, code, ...(typeof max === 'number' ? { max } : {}) });
  }
  return out;
}

/** Returns null for a result that belongs to a previous account (thrown away, nothing is shown). */
export function describeCreateTeamFailure(error: unknown): CreateTeamFailure | null {
  if (error instanceof StaleAccountError) return null;
  if (error instanceof OfflineError) return { kind: 'offline', message: bannerCopy.offline };

  if (error instanceof ApiError) {
    switch (error.code) {
      case 'rate_limited': {
        const wait = formatRetryWait(error.retryAfterSeconds);
        return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
      }
      case 'validation_failed': {
        const fields: CreateTeamFieldErrors = {};
        for (const detail of readDetails(error.details)) {
          if (detail.path === 'name' && fields.name === undefined) {
            fields.name = detail.code === 'too_long' && detail.max !== undefined ? createTeamCopy.nameTooLong(detail.max) : createTeamCopy.nameRequired;
          } else if (detail.path === 'timeZone' && fields.timeZone === undefined) {
            fields.timeZone = createTeamCopy.timeZoneInvalid;
          }
        }
        return Object.keys(fields).length > 0 ? { kind: 'fields', fields } : generic(error.requestId);
      }
      default:
        return generic(error.requestId);
    }
  }
  return generic(null);
}
