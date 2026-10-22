import type { ApiClient } from '../api/client';
import { SessionEndedError, StaleAccountError } from '../api/errors';
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
  };
}
