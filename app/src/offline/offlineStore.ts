import type { PersistedClient } from '@tanstack/react-query-persist-client';

/** What is on disk: the person it belongs to, and the persisted client (only the upcoming-shifts query is ever in it). */
export interface SavedRow {
  userId: string;
  client: PersistedClient;
}

/**
 * Where the saved shifts live on the device. The real one is `sqliteStore.ts` (expo-sqlite, plain, ADR 0010); tests use a fake. One row, so a save is
 * atomic and a clear leaves nothing behind. The methods may throw; `offlineSaving.ts` decides what that means.
 */
export interface OfflineStore {
  load(): Promise<SavedRow | null>;
  save(userId: string, client: PersistedClient): Promise<void>;
  clear(): Promise<void>;
}

/** The stored text back to a row, or null when it is not exactly what `serialize` writes. Never trusts the disk. */
export function parseSavedRow(text: string): SavedRow | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { userId, client } = value as { userId?: unknown; client?: unknown };
  if (typeof userId !== 'string' || userId === '' || typeof client !== 'object' || client === null) return null;
  const c = client as Partial<PersistedClient>;
  if (typeof c.timestamp !== 'number' || typeof c.buster !== 'string' || typeof c.clientState !== 'object' || c.clientState === null) return null;
  return { userId, client: c as PersistedClient };
}

export const serializeSavedRow = (userId: string, client: PersistedClient): string => JSON.stringify({ userId, client });
