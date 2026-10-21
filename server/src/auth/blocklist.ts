import { normalizePassword } from './password.js';

/**
 * Password blocklist (NIST SP 800-63B-4 3.1.1.2: the WHOLE prospective password is compared against a list of
 * commonly used, expected or compromised passwords; substrings and words inside it are not).
 *
 * Entries and candidates are NFC-normalised and lower-cased, so "Password1234567890" and "password1234567890"
 * are the same entry. Only passwords of the minimum length or more can ever reach this check, so a list only
 * needs entries of that length or more.
 */
export interface PasswordBlocklist {
  readonly size: number;
  has(password: string): boolean;
}

function canonical(password: string): string {
  return normalizePassword(password).toLowerCase();
}

export function createBlocklist(entries: Iterable<string>): PasswordBlocklist {
  const set = new Set<string>();
  for (const entry of entries) set.add(canonical(entry));
  return {
    get size() {
      return set.size;
    },
    has: (password) => set.has(canonical(password)),
  };
}

/**
 * The bundled list. DELIBERATELY EMPTY: no list with a confirmed data licence has been found, so none is bundled
 * (ADR 0005, decided 2026-10-21). The API logs `password_blocklist_empty` at every startup. Do not add entries
 * here without confirming their licence and recording the source in ADR 0005.
 */
export function loadBundledBlocklist(): PasswordBlocklist {
  return createBlocklist([]);
}
