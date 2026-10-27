/**
 * Activity feed settings (ADR 0022). Page size: default 20, maximum 50, both approved by Dave on 2026-10-26. They are chosen, not measured. An env var
 * overrides either; a set-but-invalid value stops the server, as for every other setting.
 */
type Env = Record<string, string | undefined>;

export interface ActivityConfig {
  /** Rows per page when the request names no `limit`. */
  pageDefault: number;
  /** The most rows one request may ask for. */
  pageMax: number;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

export function loadActivityConfig(env: Env = process.env): ActivityConfig {
  const pageDefault = positiveInt(env, 'ACTIVITY_PAGE_DEFAULT', 20);
  const pageMax = positiveInt(env, 'ACTIVITY_PAGE_MAX', 50);
  if (pageDefault > pageMax) throw new Error('ACTIVITY_PAGE_DEFAULT must not be larger than ACTIVITY_PAGE_MAX');
  return { pageDefault, pageMax };
}
