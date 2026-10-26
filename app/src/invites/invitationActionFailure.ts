import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { formatRetryWait } from '../auth/retryWait';
import { inviteFormCopy } from './inviteFormCopy';
import { invitationsCopy } from './invitationsCopy';

/** What a failed Resend or Revoke looks like. The server's error code decides which; the app only picks words. */
export type InvitationActionFailure =
  | { kind: 'rate_limited'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'not_allowed'; message: string }
  | { kind: 'gone'; message: string }
  | { kind: 'generic' };

/**
 * A 403 means the person's role no longer allows this (the server refused, nothing changed). A 404 on an invitation they could see a moment ago
 * means it is no longer pending (accepted, revoked or expired meanwhile): the list is refreshed. Anything else is the generic "please try again".
 * Returns null when the account changed or the session ended: the screen follows the session status, so nothing is shown.
 */
export function describeInvitationActionFailure(error: unknown): InvitationActionFailure | null {
  if (error instanceof StaleAccountError || error instanceof SessionEndedError || error instanceof NotSignedInError) return null;
  if (error instanceof OfflineError) return { kind: 'offline', message: inviteFormCopy.offline };
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited') {
      const wait = formatRetryWait(error.retryAfterSeconds);
      return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
    }
    if (error.code === 'forbidden') return { kind: 'not_allowed', message: invitationsCopy.notAllowed };
    if (error.code === 'not_found') return { kind: 'gone', message: invitationsCopy.gone };
  }
  return { kind: 'generic' };
}
