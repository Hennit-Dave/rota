import { ApiError } from '../api/errors';

export type ShiftLoadState = 'ready' | 'loading' | 'gone' | 'failed';

/**
 * What a screen that needs one shift shows: the shift, a loading state, "isn't available" (the server said 404: deleted, or never in this team), or a
 * failure with Try again. A 404 is never retried and never shown as a failure: it is a normal answer.
 */
export function shiftLoadState(query: { hasData: boolean; isError: boolean; error: unknown }): ShiftLoadState {
  if (query.isError && query.error instanceof ApiError && query.error.code === 'not_found') return 'gone';
  if (query.hasData) return 'ready';
  return query.isError ? 'failed' : 'loading';
}
