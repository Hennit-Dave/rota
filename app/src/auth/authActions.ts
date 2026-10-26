import type { ApiClient } from '../api/client';
import { StaleAccountError, TokenSaveError } from '../api/errors';
import { parseAuthResponse, type AuthUser } from './authResponses';
import type { AccountEpoch } from './epoch';
import type { TokenStore } from './types';

export interface AuthActionsDeps {
  client: Pick<ApiClient, 'post'>;
  tokens: TokenStore;
  epoch: AccountEpoch;
  /** The session now exists: set the store to signed in and seed the `['me']` cache with the user the server returned. */
  onSignedIn(user: AuthUser): void;
}

/**
 * Sign in and sign up. These are plain async functions, not TanStack mutations, on purpose: a mutation keeps its
 * variables in the in-memory mutation cache, and a password must never sit there (`security.md`: the app never persists
 * passwords). The password lives only in the screen's local state until the request is sent.
 */
export function createAuthActions({ client, tokens, epoch, onSignedIn }: AuthActionsDeps) {
  async function authenticate(
    path: '/auth/login' | '/auth/register' | '/auth/magic-link/redeem',
    body: Record<string, string>,
    /** Runs only after the server ACCEPTED the request and before the new session is stored (see redeemMagicLink). */
    beforeStore?: () => Promise<void>,
  ): Promise<AuthUser> {
    let epochAtStart = epoch.current;
    // Public route: no access token is attached, and a 401 here is "wrong credentials", never a refresh.
    const answer = await client.post<unknown>(path, body, { auth: false });
    const { user, tokens: pair } = parseAuthResponse(answer);

    // Signed out (or switched account) while the request ran: the result belongs to nobody. Never store it.
    if (!epoch.isCurrent(epochAtStart)) throw new StaleAccountError();

    if (beforeStore) {
      // The server said yes. Now (and only now) the account that was signed in is replaced; that sign-out bumps the epoch, and the new
      // session belongs to the epoch that starts here.
      await beforeStore();
      epochAtStart = epoch.current;
    }

    try {
      await tokens.write(pair);
    } catch {
      throw new TokenSaveError();
    }

    // A sign-out that ran while the write was in flight has already cleared the tokens; undo the write it raced with.
    if (!epoch.isCurrent(epochAtStart)) {
      await tokens.clear().catch(() => {});
      throw new StaleAccountError();
    }

    onSignedIn(user);
    return user;
  }

  return {
    login: (email: string, password: string) => authenticate('/auth/login', { email, password }),
    register: (name: string, email: string, password: string) => authenticate('/auth/register', { name, email, password }),
    /**
     * Redeem a magic link (ADR 0020): only ever called from the confirm screen's button, never when a link is merely opened. The server
     * answers like login, so the session is stored the same way. The token is sent in the body and kept nowhere.
     *
     * `replacingSession` is for someone who is already signed in: it logs that account out, but only AFTER the server accepted the link. A link
     * that turns out to be expired or used must not cost a signed-in person their session.
     */
    redeemMagicLink: (token: string, options?: { replacingSession?: () => Promise<void> }) =>
      authenticate('/auth/magic-link/redeem', { token }, options?.replacingSession),
  };
}

export type AuthActions = ReturnType<typeof createAuthActions>;
