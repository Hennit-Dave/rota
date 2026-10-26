import type { createApiClient } from '../api/client';

type Client = Pick<ReturnType<typeof createApiClient>, 'post' | 'request'>;

/**
 * The reset and magic-link requests (ADR 0020). All public routes: no access token is attached and a 401 never triggers a refresh. Every call
 * is a POST with the address or the token in the body, so a token never sits in a URL or an access log. The request answers the same whether
 * or not the address has an account, so there is nothing to read from it: success means "asked", never "an email will arrive".
 * Redeeming a magic link is `getAuthActions().redeemMagicLink` (it stores the session).
 */
export function createRecoveryApi(client: Client) {
  return {
    async requestMagicLink(email: string): Promise<void> {
      await client.post<unknown>('/auth/magic-link/request', { email: email.trim() }, { auth: false });
    },
    async requestPasswordReset(email: string): Promise<void> {
      await client.post<unknown>('/auth/password-reset/request', { email: email.trim() }, { auth: false });
    },
    /** Sets the new password and ends every session on the server (204, no body). It does not sign anyone in. */
    async submitPasswordReset(token: string, password: string): Promise<void> {
      await client.post<unknown>('/auth/password-reset/submit', { token, password }, { auth: false });
    },
  };
}
