import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

/**
 * Password hashing (ADR 0006). Argon2id at OWASP's minimum: 19 MiB of memory, 2 iterations, parallelism 1
 * (security.md). The library adds a unique random salt and writes the parameters into the hash string, so a
 * later change to these numbers still verifies every older hash.
 */
// The library's `Algorithm` is an ambient const enum, which `verbatimModuleSyntax` forbids importing as a value.
// Argon2id is 2 in that enum (see node_modules/@node-rs/argon2/index.d.ts); password.unit.test.ts asserts the
// produced hashes really are "$argon2id$v=19$m=19456,t=2,p=1".
const ARGON2ID = 2 as Algorithm;

export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export const argon2Hasher: PasswordHasher = {
  hash: (password) => argon2Hash(password, ARGON2_PARAMS),
  async verify(hash, password) {
    try {
      return await argon2Verify(hash, password);
    } catch {
      // A malformed stored hash is a failed verification, never a crash that reveals which path ran.
      return false;
    }
  },
};

/** NIST SP 800-63B-4 3.1.1.2: normalise Unicode with NFC before hashing, so one password typed two ways matches. */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

/** NIST SP 800-63B-4 3.1.1.2: "Each Unicode code point SHALL be counted as a single character". */
export function passwordLength(password: string): number {
  let n = 0;
  for (const _codePoint of password) n++;
  return n;
}

export interface PasswordService {
  /** Creates the dummy hash. Call once at startup so the first unknown-email login isn't slower. */
  ready(): Promise<void>;
  hash(password: string): Promise<string>;
  /**
   * Verifies against the account's hash, or, when there is no such account / no password, against a dummy
   * hash made with the same settings. Either way exactly one Argon2 verification runs, so timing doesn't
   * reveal whether an email has an account (security.md). Returns false for the dummy, always.
   */
  verifyAgainst(storedHash: string | null, password: string): Promise<boolean>;
}

export function createPasswordService(hasher: PasswordHasher = argon2Hasher): PasswordService {
  let dummy: Promise<string> | null = null;
  const dummyHash = () => (dummy ??= hasher.hash(randomBytes(32).toString('base64url')));

  return {
    async ready() {
      await dummyHash();
    },
    hash: (password) => hasher.hash(password),
    async verifyAgainst(storedHash, password) {
      if (storedHash === null) {
        await hasher.verify(await dummyHash(), password);
        return false;
      }
      return hasher.verify(storedHash, password);
    },
  };
}
