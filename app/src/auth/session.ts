import type { ApiClient } from '../api/client';
import { OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import type { SignOutLocal } from './signOut';

export interface SessionActionsDeps {
  client: Pick<ApiClient, 'post'>;
  isOnline(): boolean;
  signOutLocal: SignOutLocal;
}

export function createSessionActions({ client, isOnline, signOutLocal }: SessionActionsDeps) {
  return {
    /**
     * Explicit logout (app-state.md). Online: ask the server to revoke this device's session first, so a copied
     * refresh token stops working. Offline, or if the revoke fails: still do every local step at once and tell the
     * user the server could not confirm. A session the server already called invalid skips the revoke.
     */
    async logout(): Promise<{ serverConfirmed: boolean }> {
      let serverConfirmed = false;
      if (isOnline()) {
        try {
          await client.post('/auth/logout');
          serverConfirmed = true;
        } catch (error) {
          // The refresh path already signed out locally and said why; nothing more to do.
          if (error instanceof SessionEndedError) return { serverConfirmed: true };
          if (error instanceof StaleAccountError) return { serverConfirmed: true };
          serverConfirmed = false;
        }
      }
      await signOutLocal(serverConfirmed ? 'none' : 'revoke_unconfirmed');
      return { serverConfirmed };
    },

    /**
     * Log out of every device. Unlike logout, this does NOT sign out locally when the server cannot be reached:
     * signing out here without ending the other sessions would tell the user every device is ended when it is not.
     * Offline or failing, it throws and the user is still signed in, so they can try again.
     */
    async logoutAll(): Promise<void> {
      if (!isOnline()) throw new OfflineError();
      try {
        await client.post('/auth/logout-all');
      } catch (error) {
        // Already signed out (the refresh path, or another sign-out): nothing more to do.
        if (error instanceof SessionEndedError || error instanceof StaleAccountError) return;
        throw error;
      }
      // The server ended every session, including this one. Clean up locally.
      await signOutLocal('none');
    },
  };
}
