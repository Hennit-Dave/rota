import { ApiError } from '../api/errors';

/**
 * A user's settings as the server describes them (docs/ARCHITECTURE.md, GET /settings; ADR 0024). Every setting is `{ value, updatedAt }`: the value, and
 * when the SERVER last changed it (null = never changed, the value is the default). The app only shows these: the server is the single source of truth and
 * stamps every change itself, so the app never sends or invents an `updatedAt`.
 */
export type ThemeSetting = 'system' | 'light' | 'dark';
export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark'];

/** 'en' only until there are translations (ADR 0024). */
export const LANGUAGE_SETTINGS: readonly string[] = ['en'];

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", wall-clock time in the user's time zone. */
  start: string;
  end: string;
}

export interface SettingField<T> {
  value: T;
  updatedAt: string | null;
}

export interface Settings {
  quietHours: SettingField<QuietHours>;
  timeZone: SettingField<string | null>;
  notifyShiftChanges: SettingField<boolean>;
  notifySwapUpdates: SettingField<boolean>;
  notifyBilling: SettingField<boolean>;
  language: SettingField<string>;
  theme: SettingField<ThemeSetting>;
}

export type SettingKey = keyof Settings;
export type SettingValue<K extends SettingKey> = Settings[K]['value'];

/** One change: ONE field and its new value. The union keeps a key and its value type together. */
export type SettingChange = { [K in SettingKey]: { key: K; value: SettingValue<K> } }[SettingKey];

/** Personal, so the key carries the user ID (app-state.md): another account never sees this cache. */
export const settingsKey = (userId: string) => ['settings', userId] as const;
/** The mutation of ONE field of one user's settings: how a control knows its own change is still on its way. */
export const settingMutationKey = (userId: string, key: SettingKey) => ['settings', userId, key] as const;
export const settingsMutationPrefix = (userId: string) => ['settings', userId] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stamp = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined);

function field<T>(raw: unknown, readValue: (value: unknown) => T | undefined): SettingField<T> | null {
  if (!isRecord(raw)) return null;
  const value = readValue(raw.value);
  const updatedAt = stamp(raw.updatedAt);
  return value === undefined || updatedAt === undefined ? null : { value, updatedAt };
}

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
const theme = (v: unknown) => (THEME_SETTINGS.includes(v as ThemeSetting) ? (v as ThemeSetting) : undefined);
const zone = (v: unknown) => (v === null ? null : typeof v === 'string' ? v : undefined);
const quiet = (v: unknown): QuietHours | undefined =>
  isRecord(v) && typeof v.enabled === 'boolean' && typeof v.start === 'string' && typeof v.end === 'string' ? { enabled: v.enabled, start: v.start, end: v.end } : undefined;

/** The `settings` of the server's answer, or null when it is not what the app expects. Never trusts the shape. */
export function parseSettings(body: unknown): Settings | null {
  if (!isRecord(body) || !isRecord(body.settings)) return null;
  const s = body.settings;
  const quietHours = field(s.quietHours, quiet);
  const timeZone = field(s.timeZone, zone);
  const notifyShiftChanges = field(s.notifyShiftChanges, bool);
  const notifySwapUpdates = field(s.notifySwapUpdates, bool);
  const notifyBilling = field(s.notifyBilling, bool);
  const language = field(s.language, text);
  const themeField = field(s.theme, theme);
  if (!quietHours || !timeZone || !notifyShiftChanges || !notifySwapUpdates || !notifyBilling || !language || !themeField) return null;
  return { quietHours, timeZone, notifyShiftChanges, notifySwapUpdates, notifyBilling, language, theme: themeField };
}

export function parseSettingsResponse(body: unknown): Settings {
  const settings = parseSettings(body);
  if (!settings) throw new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
  return settings;
}

/** Two values of one setting are the same (quiet hours is an object, the rest are primitives). */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
