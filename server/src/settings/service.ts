import type { PrismaClient } from '../generated/prisma/client.js';
import type { SettingsChange } from './schemas.js';

/**
 * A user's settings (ADR 0024, brief Requirement 7). The server is the single source of truth: every device shows a copy and replaces it with this one.
 *
 * Each setting has its own `updatedAt`, stamped by the DATABASE clock (`clock_timestamp()`, read after the row lock is taken, so the stamp is when this
 * value was actually written), never by the client. A change touches ONE field, so a theme change on a phone and a quiet-hours change on a tablet both
 * survive. "Most recent wins" means the later ARRIVAL wins; the weakness is written down in docs/STATE.md.
 *
 * Settings are identity data on shard A and are read and written on the primary (data.md: identityDb). The table is read and written with raw SQL so
 * that the database, not Node, makes the timestamp.
 */

export interface SettingField<T> {
  value: T;
  /** When the server last changed this setting; null = never changed, the value is the default. */
  updatedAt: Date | null;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", wall-clock time in the user's time zone. */
  start: string;
  end: string;
}

export interface Settings {
  quietHours: SettingField<QuietHours>;
  /** IANA name, or null = not chosen: enforcement falls back to the team's time zone (ADR 0024). */
  timeZone: SettingField<string | null>;
  notifyShiftChanges: SettingField<boolean>;
  notifySwapUpdates: SettingField<boolean>;
  notifyBilling: SettingField<boolean>;
  language: SettingField<string>;
  theme: SettingField<string>;
}

/** What a user with no row has. Mirrors the column defaults in the migration; a test inserts a bare row and compares the two. */
export const DEFAULT_SETTINGS: Settings = {
  quietHours: { value: { enabled: false, start: '22:00', end: '06:00' }, updatedAt: null },
  timeZone: { value: null, updatedAt: null },
  notifyShiftChanges: { value: true, updatedAt: null },
  notifySwapUpdates: { value: true, updatedAt: null },
  notifyBilling: { value: true, updatedAt: null },
  language: { value: 'en', updatedAt: null },
  theme: { value: 'system', updatedAt: null },
};

interface Row {
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_updated_at: Date | null;
  time_zone: string | null;
  time_zone_updated_at: Date | null;
  notify_shift_changes: boolean;
  notify_shift_changes_updated_at: Date | null;
  notify_swap_updates: boolean;
  notify_swap_updates_updated_at: Date | null;
  notify_billing: boolean;
  notify_billing_updated_at: Date | null;
  language: string;
  language_updated_at: Date | null;
  theme: string;
  theme_updated_at: Date | null;
}

export function settingsFromRow(row: Row): Settings {
  return {
    quietHours: { value: { enabled: row.quiet_hours_enabled, start: row.quiet_hours_start, end: row.quiet_hours_end }, updatedAt: row.quiet_hours_updated_at },
    timeZone: { value: row.time_zone, updatedAt: row.time_zone_updated_at },
    notifyShiftChanges: { value: row.notify_shift_changes, updatedAt: row.notify_shift_changes_updated_at },
    notifySwapUpdates: { value: row.notify_swap_updates, updatedAt: row.notify_swap_updates_updated_at },
    notifyBilling: { value: row.notify_billing, updatedAt: row.notify_billing_updated_at },
    language: { value: row.language, updatedAt: row.language_updated_at },
    theme: { value: row.theme, updatedAt: row.theme_updated_at },
  };
}

/** Reads the user's settings from the primary. No row yet = the defaults, every `updatedAt` null. */
export async function getSettings(db: PrismaClient, userId: string): Promise<Settings> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT quiet_hours_enabled,
           to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
           to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
           quiet_hours_updated_at,
           time_zone, time_zone_updated_at,
           notify_shift_changes, notify_shift_changes_updated_at,
           notify_swap_updates, notify_swap_updates_updated_at,
           notify_billing, notify_billing_updated_at,
           language, language_updated_at,
           theme, theme_updated_at
    FROM user_settings
    WHERE user_id = ${userId}::uuid`;
  const row = rows[0];
  return row ? settingsFromRow(row) : structuredClone(DEFAULT_SETTINGS);
}

/**
 * Applies ONE change and returns all the settings. The first change creates the row (the other fields keep their column defaults and a NULL stamp);
 * later ones update only their own columns. One statement, so two simultaneous changes to the same field serialise on the row and the later one wins.
 * `userId` is the signed-in user's: the caller never sends it.
 */
export async function changeSetting(db: PrismaClient, userId: string, change: SettingsChange): Promise<Settings> {
  if ('quietHours' in change) {
    const { enabled, start, end } = change.quietHours;
    await db.$executeRaw`
      INSERT INTO user_settings (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_updated_at)
      VALUES (${userId}::uuid, ${enabled}, ${start}::time, ${end}::time, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE
      SET quiet_hours_enabled = EXCLUDED.quiet_hours_enabled, quiet_hours_start = EXCLUDED.quiet_hours_start,
          quiet_hours_end = EXCLUDED.quiet_hours_end, quiet_hours_updated_at = clock_timestamp()`;
  } else if ('timeZone' in change) {
    await db.$executeRaw`
      INSERT INTO user_settings (user_id, time_zone, time_zone_updated_at)
      VALUES (${userId}::uuid, ${change.timeZone}, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET time_zone = EXCLUDED.time_zone, time_zone_updated_at = clock_timestamp()`;
  } else if ('notifyShiftChanges' in change) {
    await db.$executeRaw`
      INSERT INTO user_settings (user_id, notify_shift_changes, notify_shift_changes_updated_at)
      VALUES (${userId}::uuid, ${change.notifyShiftChanges}, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE
      SET notify_shift_changes = EXCLUDED.notify_shift_changes, notify_shift_changes_updated_at = clock_timestamp()`;
  } else if ('notifySwapUpdates' in change) {
    await db.$executeRaw`
      INSERT INTO user_settings (user_id, notify_swap_updates, notify_swap_updates_updated_at)
      VALUES (${userId}::uuid, ${change.notifySwapUpdates}, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE
      SET notify_swap_updates = EXCLUDED.notify_swap_updates, notify_swap_updates_updated_at = clock_timestamp()`;
  } else if ('notifyBilling' in change) {
    await db.$executeRaw`
      INSERT INTO user_settings (user_id, notify_billing, notify_billing_updated_at)
      VALUES (${userId}::uuid, ${change.notifyBilling}, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE
      SET notify_billing = EXCLUDED.notify_billing, notify_billing_updated_at = clock_timestamp()`;
  } else if ('language' in change) {
    await db.$executeRaw`
      INSERT INTO user_settings (user_id, language, language_updated_at)
      VALUES (${userId}::uuid, ${change.language}, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET language = EXCLUDED.language, language_updated_at = clock_timestamp()`;
  } else {
    await db.$executeRaw`
      INSERT INTO user_settings (user_id, theme, theme_updated_at)
      VALUES (${userId}::uuid, ${change.theme}, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme, theme_updated_at = clock_timestamp()`;
  }
  return getSettings(db, userId);
}
