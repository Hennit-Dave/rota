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
  async function authenticate(path: '/auth/login' | '/auth/register', body: Record<string, string>): Promise<AuthUser> {
    const epochAtStart = epoch.current;
    // Public route: no access token is attached, and a 401 here is "wrong credentials", never a refresh.
    const answer = await client.post<unknown>(path, body, { auth: false });
    const { user, tokens: pair } = parseAuthResponse(answer);

    // Signed out (or switched account) while the request ran: the result belongs to nobody. Never store it.
    if (!epoch.isCurrent(epochAtStart)) throw new StaleAccountError();

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
  };
}

export type AuthActions = ReturnType<typeof createAuthActions>;
