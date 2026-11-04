import { ConfigError } from '../api/config';
import { ApiError, NetworkError, NotSignedInError, OfflineError, RefreshUncertainError, RefreshUnavailableError, SessionEndedError, StaleAccountError } from '../api/errors';

/**
 * Which errors are worth a Sentry event (ADR 0039). Only a bug is. The app's quota is small (20 events a session, and the Developer plan's 5,000 errors are shared with
 * the API and the worker), and most failures are ordinary: no connection, a session that ended, a request the server refused for a good reason.
 *
 *  - NOT reported: offline, a lost connection or a timeout, a signed-out device, a session the server ended, a refresh that could not be decided, an account that changed
 *    under a request, an aborted or cancelled request, and any answer from the server below 500 (401, 403, 404, 409, 429...). 503 is the server saying "briefly unavailable"
 *    (the database or Valkey), which the API reports itself, so the app does not.
 *  - Reported: a server error (500 and above except 503), which carries the request ID so the two events can be joined; a bad configuration; and any other error, which is a
 *    bug in the app (a thrown TypeError, a response in a shape the app did not expect...).
 */
export function isReportableError(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500 && error.status !== 503;
  if (
    error instanceof OfflineError ||
    error instanceof NetworkError ||
    error instanceof NotSignedInError ||
    error instanceof SessionEndedError ||
    error instanceof RefreshUnavailableError ||
    error instanceof RefreshUncertainError ||
    error instanceof StaleAccountError
  ) {
    return false;
  }
  if (error instanceof ConfigError) return true;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'CancelledError')) return false;
  return true;
}

/** The request ID of a failing server answer, for the `request_id` tag. */
export function requestIdOf(error: unknown): string | null {
  return error instanceof ApiError ? error.requestId : null;
}
