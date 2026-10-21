import type { RequestHandler } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';
import { isSessionActive } from './sessions.js';
import { TokenError, type TokenService } from './tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth. Identity comes only from a verified access token AND a live session, never the body. */
    auth?: { userId: string; familyId: string };
  }
}

// RFC 7235: the scheme name is case-insensitive. One space, then a JWT (base64url segments and dots).
const BEARER = /^bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/**
 * User-route pipeline (security.md): access token, then the session check on shard A's primary. Every failure
 * is the same public 401; the real reason is logged server-side only.
 */
export function createRequireAuth(deps: {
  tokens: TokenService;
  db: Pick<PrismaClient, '$queryRaw'>;
}): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization');
    if (!header) {
      next(new ApiError('unauthenticated', { reason: 'missing_token' }));
      return;
    }
    const match = BEARER.exec(header);
    if (!match) {
      next(new ApiError('unauthenticated', { reason: 'malformed_authorization_header' }));
      return;
    }

    let claims;
    try {
      claims = await deps.tokens.verify(match[1]!);
    } catch (err) {
      if (err instanceof TokenError) {
        next(new ApiError('unauthenticated', { reason: `token_${err.reason}` }));
        return;
      }
      next(err);
      return;
    }

    if (!(await isSessionActive(deps.db, claims.userId, claims.familyId))) {
      next(new ApiError('unauthenticated', { reason: 'session_inactive' }));
      return;
    }

    req.auth = claims;
    res.locals.userId = claims.userId;
    res.locals.familyId = claims.familyId;
    res.locals.dbRoute = 'primary-required';
    next();
  };
}
