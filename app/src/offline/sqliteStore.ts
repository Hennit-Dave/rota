import * as SQLite from 'expo-sqlite';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { parseSavedRow, serializeSavedRow, type OfflineStore, type SavedRow } from './offlineStore';

const DB_NAME = 'rota-offline.db';
const KEY = 'upcoming';

/**
 * The real store: expo-sqlite, plain, no SQLCipher and never the vec extension (ADR 0010). One table, one row. `secure_delete` makes SQLite overwrite what
 * a DELETE removes, and the checkpoint after a clear empties the write-ahead log, so a sign-out leaves no copy of the shifts in the file.
 * Not unit-tested (it needs the native module); the emulator proof opens the file after a sign-out.
 */
export function createSqliteStore(): OfflineStore {
  let opening: Promise<SQLite.SQLiteDatabase> | null = null;
  const open = () => {
    opening ??= SQLite.openDatabaseAsync(DB_NAME)
      .then(async (db) => {
        await db.execAsync('PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS offline_saved (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
        return db;
      })
      .catch((error: unknown) => {
        opening = null; // try again next time rather than failing for ever
        throw error;
      });
    return opening;
  };

  return {
    async load(): Promise<SavedRow | null> {
      const db = await open();
      const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM offline_saved WHERE key = ?', KEY);
      if (!row) return null;
      const parsed = parseSavedRow(row.value);
      if (!parsed) await this.clear(); // not ours or damaged: keep nothing
      return parsed;
    },
    async save(userId: string, client: PersistedClient): Promise<void> {
      const db = await open();
      await db.runAsync('INSERT OR REPLACE INTO offline_saved (key, value) VALUES (?, ?)', KEY, serializeSavedRow(userId, client));
    },
    async clear(): Promise<void> {
      const db = await open();
      await db.runAsync('DELETE FROM offline_saved');
      await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    },
  };
}
