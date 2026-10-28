import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { formatRetryWait } from '../auth/retryWait';
import { swapFailureCopy } from './swapCopy';

/** What a failed swap call looks like on screen. The server's code decides which; the app only picks words. */
export type SwapFailure =
  | { kind: 'offline' }
  | { kind: 'banner'; message: string }
  | { kind: 'gone' }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'generic'; reference: string | null };

function firstDetail(details: unknown): { path: string; code: string } | null {
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if (typeof d === 'object' && d !== null) {
      const { path, code } = d as Record<string, unknown>;
      if (typeof path === 'string' && typeof code === 'string') return { path, code };
    }
  }
  return null;
}

/**
 * Maps whatever a swap request, a cancel or a decision threw to what the screen shows. `null` means the account changed or the session ended: the screen
 * follows the session instead. A 409 says WHY in a detail code (a shift changed, would double-book, already in a swap); a 404 means the swap is gone.
 */
export function describeSwapFailure(error: unknown): SwapFailure | null {
  if (error instanceof StaleAccountError || error instanceof SessionEndedError || error instanceof NotSignedInError) return null;
  if (error instanceof OfflineError) return { kind: 'offline' };
  if (!(error instanceof ApiError)) return { kind: 'generic', reference: null };
  const detail = firstDetail(error.details);
  switch (error.code) {
    case 'not_found':
      return { kind: 'gone' };
    case 'forbidden':
      return { kind: 'banner', message: swapFailureCopy.forbidden };
    case 'swap_limit_reached':
      return { kind: 'banner', message: swapFailureCopy.limit };
    case 'swap_not_pending':
      return { kind: 'banner', message: swapFailureCopy.notPending };
    case 'swap_not_possible':
      if (detail?.code === 'would_double_book') return { kind: 'banner', message: swapFailureCopy.wouldDoubleBook };
      if (detail?.code === 'already_in_swap') return { kind: 'banner', message: swapFailureCopy.alreadyInSwap };
      return { kind: 'banner', message: swapFailureCopy.changed };
    case 'validation_failed':
      if (detail?.code === 'not_yours') return { kind: 'banner', message: swapFailureCopy.notYours };
      if (detail?.code === 'in_past') return { kind: 'banner', message: swapFailureCopy.inPast };
      if (detail?.code === 'not_swappable') return { kind: 'banner', message: swapFailureCopy.notSwappable };
      return { kind: 'generic', reference: error.requestId };
    case 'rate_limited': {
      const wait = formatRetryWait(error.retryAfterSeconds);
      return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
    }
    default:
      return { kind: 'generic', reference: error.requestId };
  }
}
