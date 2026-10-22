import type { ApiClient } from '../api/client';
import { ApiError, NotSignedInError, SessionEndedError, StaleAccountError } from '../api/errors';
import { parseMe, type AuthUser } from './authResponses';
import type { SignOutLocal } from './signOut';
import type { TokenStore } from './types';

/**
 * - `signed_in`: the server confirmed the session (GET /auth/me, refreshing once if the access token had expired).
 * - `signed_out`: no tokens on the device.
 * - `session_ended`: the server refused the session; the device has been signed out locally with that notice.
 * - `unverified`: the tokens exist but the server could not be asked or did not answer (offline, timeout, 429, 503,
 *   an uncertain refresh). The session is KEPT (app-state.md); the signed-in side shows its own offline or error state.
 */
export type RestoreOutcome = 'signed_in' | 'signed_out' | 'session_ended' | 'unverified';

export interface RestoreDeps {
  tokens: Pick<TokenStore, 'read'>;
  client: Pick<ApiClient, 'get'>;
  signOutLocal: SignOutLocal;
  /** `user` is null when the session could not be verified. */
  onSignedIn(user: AuthUser | null): void;
  onSignedOut(): void;
}

/** App start (docs/STATE.md): find out whether the stored session still works BEFORE deciding which side to show. */
export function createRestoreSession({ tokens, client, signOutLocal, onSignedIn, onSignedOut }: RestoreDeps) {
  return async function restoreSession(): Promise<RestoreOutcome> {
    let hasTokens = false;
    try {
      hasTokens = (await tokens.read()) !== null;
    } catch {
      // unreadable secure-store is treated as signed out
    }
    if (!hasTokens) {
      onSignedOut();
      return 'signed_out';
    }

    try {
      const body = await client.get<unknown>('/auth/me');
      const user = parseMe(body);
      if (!user) {
        // The server answered, but not in a shape we can use: do not claim it was verified.
        onSignedIn(null);
        return 'unverified';
      }
      onSignedIn(user);
      return 'signed_in';
    } catch (error) {
      // The refresh path already signed this device out locally and said why.
      if (error instanceof SessionEndedError) return 'session_ended';
      // A 401 that survived a successful refresh: the session is not valid.
      if (error instanceof ApiError && error.status === 401) {
        await signOutLocal('session_ended');
        return 'session_ended';
      }
      if (error instanceof NotSignedInError) {
        onSignedOut();
        return 'signed_out';
      }
      // A sign-out ran while this was in flight; it has already set the state.
      if (error instanceof StaleAccountError) return 'signed_out';
      onSignedIn(null);
      return 'unverified';
    }
  };
}

export type RestoreSession = ReturnType<typeof createRestoreSession>;
