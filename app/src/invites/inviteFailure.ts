import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { formatRetryWait } from '../auth/retryWait';

/** What a failed preview or accept looks like. The server's error code decides which; the app only picks words. */
export type InviteFailure =
  | { kind: 'unavailable' }
  | { kind: 'wrong_account' }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'generic'; message: string; reference: string | null };

/**
 * `invite_unavailable` (404) is the one answer for every unusable link: expired, used, revoked, unknown, malformed (ADR 0015).
 * `invite_wrong_account` (403) is accept refusing a signed-in account that is not the invited one; nothing was granted.
 * Returns null when the account changed or the session ended: the screen follows the session status instead, so nothing is shown.
 */
export function describeInviteFailure(error: unknown): InviteFailure | null {
  if (error instanceof StaleAccountError || error instanceof SessionEndedError || error instanceof NotSignedInError) return null;
  if (error instanceof OfflineError) return { kind: 'offline', message: bannerCopy.offline };
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invite_unavailable':
        return { kind: 'unavailable' };
      case 'invite_wrong_account':
        return { kind: 'wrong_account' };
      case 'rate_limited': {
        const wait = formatRetryWait(error.retryAfterSeconds);
        return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
      }
      default:
        return { kind: 'generic', message: bannerCopy.generic, reference: error.requestId };
    }
  }
  return { kind: 'generic', message: bannerCopy.generic, reference: null };
}
