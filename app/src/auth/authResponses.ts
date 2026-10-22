import { ApiError } from '../api/errors';
import type { TokenPair } from './types';

/** The user the server describes (GET /auth/me, and the login and register answers). Server data, never trusted for access. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseUser(value: unknown): AuthUser | null {
  if (!isRecord(value)) return null;
  const { id, email, name, emailVerified } = value;
  if (typeof id !== 'string' || typeof email !== 'string' || typeof name !== 'string' || typeof emailVerified !== 'boolean') {
    return null;
  }
  return { id, email, name, emailVerified };
}

/** `{ user }` as GET /auth/me answers. */
export function parseMe(body: unknown): AuthUser | null {
  return isRecord(body) ? parseUser(body.user) : null;
}

/** `{ user, session }` as POST /auth/login and /auth/register answer. Throws if the answer cannot be read. */
export function parseAuthResponse(body: unknown): { user: AuthUser; tokens: TokenPair } {
  const user = isRecord(body) ? parseUser(body.user) : null;
  const session = isRecord(body) && isRecord(body.session) ? body.session : null;
  const accessToken = session?.accessToken;
  const refreshToken = session?.refreshToken;
  if (!user || typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
  }
  return { user, tokens: { accessToken, refreshToken } };
}
