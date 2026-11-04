import { ApiError, NetworkError, OfflineError } from '../api/errors';

/**
 * Whether the schedule may show the saved shifts instead of an error: the phone is offline, or the server could not be reached or was not well (timeout,
 * dropped connection, 5xx, 429). A server that ANSWERED with a refusal (401, 403, 404, 400...) is never covered by an old copy: that answer is about
 * what this person may see now (app-state.md). Anything still loading, or any other failure, shows no saved data.
 */
export function savedShiftsApply(input: { error: unknown; online: boolean }): boolean {
  const { error } = input;
  if (error instanceof ApiError) return error.status >= 500 || error.status === 429;
  return !input.online || error instanceof OfflineError || error instanceof NetworkError;
}
