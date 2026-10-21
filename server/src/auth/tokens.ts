import { errors, jwtVerify, SignJWT } from 'jose';
import type { AuthConfig } from './config.js';

/**
 * Access tokens (security.md, ADR 0005). Signed JWT, algorithm FIXED to HS256 with a random server secret.
 * Claims: sub (user ID), sid (session = token-family ID), iat, exp, iss, aud. No role and no team: roles are
 * loaded from the database on every request so a demotion takes effect at once.
 *
 * Verification: only HS256 is accepted (so `none` and every other algorithm are refused), then signature,
 * exp, iss and aud, then both IDs must be UUIDs. Whether the session is still alive is checked separately,
 * against the database, on every authenticated request.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessTokenClaims {
  userId: string;
  familyId: string;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/** Why verification failed. Logged server-side only; the client always sees `unauthenticated`. */
export class TokenError extends Error {
  constructor(readonly reason: string) {
    super(`invalid access token: ${reason}`);
    this.name = 'TokenError';
  }
}

export interface TokenService {
  sign(claims: AccessTokenClaims): Promise<SignedAccessToken>;
  verify(token: string): Promise<AccessTokenClaims>;
}

export function createTokenService(options: {
  secret: Uint8Array;
  config: Pick<AuthConfig, 'accessTokenMinutes' | 'clockSkewSeconds' | 'issuer' | 'audience'>;
  now?: () => Date;
}): TokenService {
  const { secret, config } = options;
  const now = options.now ?? (() => new Date());

  return {
    async sign({ userId, familyId }) {
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + config.accessTokenMinutes * 60_000);
      const token = await new SignJWT({ sid: familyId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(secret);
      return { token, expiresAt };
    },

    async verify(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, secret, {
          algorithms: ['HS256'],
          issuer: config.issuer,
          audience: config.audience,
          clockTolerance: config.clockSkewSeconds,
          currentDate: now(),
          requiredClaims: ['sub', 'sid', 'iat', 'exp'],
        }));
      } catch (err) {
        if (err instanceof errors.JWTExpired) throw new TokenError('expired');
        if (err instanceof errors.JWSSignatureVerificationFailed) throw new TokenError('bad_signature');
        if (err instanceof errors.JOSEAlgNotAllowed) throw new TokenError('bad_alg');
        if (err instanceof errors.JWTClaimValidationFailed) throw new TokenError('bad_claim');
        if (err instanceof errors.JWTInvalid || err instanceof errors.JWSInvalid) throw new TokenError('malformed');
        throw new TokenError('invalid');
      }
      const userId = payload.sub;
      const familyId = payload.sid;
      if (typeof userId !== 'string' || !UUID.test(userId)) throw new TokenError('bad_sub');
      if (typeof familyId !== 'string' || !UUID.test(familyId)) throw new TokenError('bad_sid');
      // Anything else in the payload (a "role", a "team") is ignored on purpose; only these two IDs are returned.
      return { userId: userId.toLowerCase(), familyId: familyId.toLowerCase() };
    },
  };
}
