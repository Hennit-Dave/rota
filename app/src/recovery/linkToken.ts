/** The longest value the server accepts for a link token (server/src/auth/schemas.ts). A longer one cannot be a link we sent. */
export const MAX_LINK_TOKEN_LENGTH = 200;

/**
 * The magic-link or reset token from the route: Expo Router hands a param over as a string, a list (a repeated key) or nothing. Anything else is
 * "no token". The app never looks inside it: the server decides what it opens (ADR 0020), and the token is a credential, so it is never logged,
 * never stored and never part of a cache key.
 */
export function readLinkToken(param: string | string[] | undefined): string | null {
  const value = Array.isArray(param) ? param[0] : param;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LINK_TOKEN_LENGTH) return null;
  return trimmed;
}
