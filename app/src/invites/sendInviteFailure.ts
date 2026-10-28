import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { formatRetryWait } from '../auth/retryWait';
import { readDetails } from '../teams/createTeamFailure';
import { inviteFormCopy } from './inviteFormCopy';

/** What a failed "Send invitation" or "Resend" looks like. The server's error code decides which; the app only picks words. */
export type SendInviteFailure =
  | { kind: 'fields'; fields: { email?: string } }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'not_allowed'; message: string }
  | { kind: 'link_limit'; message: string }
  | { kind: 'generic'; message: string; reference: string | null };

const generic = (reference: string | null): SendInviteFailure => ({ kind: 'generic', message: bannerCopy.generic, reference });

/**
 * `already_member` and `invite_pending` (409) are about the address, so they sit under the email field (Figma 291:781, 291:821).
 * A 400 about the email is the server's own check of its shape (the app checks only that something was typed). A 403 or 404 means the
 * person's role changed under them: the server refused, nothing was sent.
 * Returns null when the account changed or the session ended: the screen follows the session status, so nothing is shown.
 */
export function describeSendInviteFailure(error: unknown): SendInviteFailure | null {
  if (error instanceof StaleAccountError || error instanceof SessionEndedError || error instanceof NotSignedInError) return null;
  if (error instanceof OfflineError) return { kind: 'offline', message: inviteFormCopy.offline };
  if (!(error instanceof ApiError)) return generic(null);
  switch (error.code) {
    case 'already_member':
      return { kind: 'fields', fields: { email: inviteFormCopy.alreadyMember } };
    case 'invite_pending':
      return { kind: 'fields', fields: { email: inviteFormCopy.alreadyPending } };
    case 'validation_failed': {
      const emailProblem = readDetails(error.details).some((detail) => detail.path === 'email');
      return emailProblem ? { kind: 'fields', fields: { email: inviteFormCopy.emailInvalid } } : generic(error.requestId);
    }
    case 'rate_limited': {
      const wait = formatRetryWait(error.retryAfterSeconds);
      return { kind: 'rate_limited', message: wait ? bannerCopy.rateLimited(wait) : bannerCopy.rateLimitedNoWait };
    }
    case 'invite_link_limit':
      return { kind: 'link_limit', message: inviteFormCopy.link.limit };
    case 'forbidden':
    case 'not_found':
      return { kind: 'not_allowed', message: inviteFormCopy.notAllowed };
    default:
      return generic(error.requestId);
  }
}
