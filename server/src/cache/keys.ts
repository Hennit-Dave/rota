import { createHash } from 'node:crypto';
import { CANONICAL_UUID } from '../db/shard.js';
import type { CacheKind } from './config.js';

/**
 * Cache keys (caching.md). A key holds EVERY input that shapes the response, so two requests that differ in any input never share an entry:
 *   generation:  cache:v1:team:<teamId>:<kind>:gen
 *   entry:       cache:v1:team:<teamId>:<kind>:<generation>:<scope>[:<param>...]
 * Every piece is validated here, so a value that could add a ":" or change what the key means is refused instead of built into a key.
 */

/** Who the response is the same for: everyone allowed to see the team's data, or one person (a personal view such as "my shifts"). */
export type Scope = 'team' | `user:${string}`;

export const generationKey = (teamId: string, kind: CacheKind): string => {
  assertUuid(teamId, 'teamId');
  return `cache:v1:team:${teamId}:${kind}:gen`;
};

export function entryKey(teamId: string, kind: CacheKind, generation: string, scope: Scope, params: readonly string[]): string {
  assertUuid(teamId, 'teamId');
  assertUuid(generation, 'generation');
  if (scope !== 'team') {
    if (!scope.startsWith('user:')) throw new Error('cache key: scope must be "team" or "user:<id>"');
    assertUuid(scope.slice('user:'.length), 'scope user');
  }
  for (const p of params) {
    if (!/^[A-Za-z0-9_.+-]+$/.test(p)) throw new Error('cache key: a parameter may hold only letters, digits and _ . + -');
  }
  return `cache:v1:team:${teamId}:${kind}:${generation}:${scope}${params.map((p) => `:${p}`).join('')}`;
}

/** A short, stable hash of the normalised filters, so a new filter changes the key (caching.md). Keys are sorted, so the order a client sent them in does not matter. */
export function filtersHash(filters: Record<string, string | number | boolean | null>): string {
  const normalised = Object.keys(filters)
    .sort()
    .map((k) => [k, filters[k]]);
  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex').slice(0, 16);
}

function assertUuid(value: string, what: string): void {
  if (!CANONICAL_UUID.test(value)) throw new Error(`cache key: ${what} must be a canonical UUID`);
}
