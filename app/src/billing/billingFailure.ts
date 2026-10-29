import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { formatRetryWait } from '../auth/retryWait';

/** What a failed billing call looks like on screen. The server's error code decides which; the app only picks words. */
export type BillingFailure =
  | { kind: 'offline' }
  | { kind: 'banner'; message: string }
  | { kind: 'gone' }
  | { kind: 'rate_limited'; message: string }
  /** The payment service could not be reached or did not answer. Nothing was recorded as paid or failed: trying again with the same key is safe. */
  | { kind: 'unavailable' }
  | { kind: 'generic'; reference: string | null };

const messages = {
  forbidden: 'Only the team’s Owner manages billing.',
  inProgress: 'A payment for this team is already in progress. If it is being confirmed, wait a moment and check again.',
  alreadyActivated: 'This team already has a subscription.',
  seatsBelowMembers: 'There are more people on the team than the seats you chose.',
  invalid: 'Check the plan and the number of seats.',
} as const;

/**
 * Maps whatever a billing call threw to what the screen shows. `null` means the account changed or the session ended: the screen follows the session
 * instead. A 503 is "the payment service did not answer": the screen offers Try again with the SAME idempotency key.
 */
export function describeBillingFailure(error: unknown): BillingFailure | null {
  if (error instanceof StaleAccountError || error instanceof SessionEndedError || error instanceof NotSignedInError) return null;
  if (error instanceof OfflineError) return { kind: 'offline' };
  if (!(error instanceof ApiError)) return { kind: 'generic', reference: null };
  switch (error.code) {
    case 'not_found':
      return { kind: 'gone' };
    case 'forbidden':
      return { kind: 'banner', message: messages.forbidden };
    case 'payment_in_progress':
      return { kind: 'banner', message: messages.inProgress };
    case 'already_activated':
      return { kind: 'banner', message: messages.alreadyActivated };
    case 'seats_below_members':
      return { kind: 'banner', message: messages.seatsBelowMembers };
    case 'validation_failed':
      return { kind: 'banner', message: messages.invalid };
    case 'service_unavailable':
      return { kind: 'unavailable' };
    case 'rate_limited': {
      const wait = formatRetryWait(error.retryAfterSeconds);
      return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
    }
    default:
      return { kind: 'generic', reference: error.requestId };
  }
}
