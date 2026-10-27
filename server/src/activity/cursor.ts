import { CANONICAL_UUID } from '../db/shard.js';

/**
 * The feed's cursor: an opaque bookmark the SERVER builds from the last row it returned, `(created_at, id)`. Clients hand it back unchanged and never
 * build one. It is base64url of `{"t":"<ISO time, milliseconds, Z>","i":"<uuid>"}`.
 *
 * A cursor is user input, so decoding is strict (security.md): only the base64url alphabet, a bounded length, canonical encoding (no alternative
 * spellings of the same bytes), JSON with exactly the keys `t` and `i`, a time that survives a round trip through Date unchanged, and a canonical
 * lowercase UUID. Anything else returns null and the request is a 400. A cursor carries no team: the query always filters by the caller's team, so another
 * team's cursor values can only ever return the caller's own rows.
 */
export interface Cursor {
  /** `created_at` of the last row returned, at millisecond precision (the column is timestamptz(3)). */
  t: Date;
  /** `id` of that row. */
  i: string;
}

const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALPHABET = /^[A-Za-z0-9_-]+$/;
/** The longest valid cursor is about 90 characters; this only bounds the work done on junk. */
const MAX_LENGTH = 200;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.t.toISOString(), i: cursor.i }), 'utf8').toString('base64url');
}

export function decodeCursor(text: string): Cursor | null {
  if (text.length === 0 || text.length > MAX_LENGTH || !ALPHABET.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null; // non-canonical spelling of the same bytes
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'i' || keys[1] !== 't') return null;
  const { t, i } = value as { t: unknown; i: unknown };
  if (typeof t !== 'string' || typeof i !== 'string') return null;
  if (!ISO_MS_Z.test(t) || !CANONICAL_UUID.test(i)) return null;
  const date = new Date(t);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== t) return null; // e.g. 2026-02-30 rolls over: refused
  return { t: date, i };
}
