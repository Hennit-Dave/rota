import type { SettingChange } from './settingsResponses';

/**
 * What the Settings screen last has to tell the person about a change: it was saved, or it was not and the old value is back (Figma 9:289 "settings-error",
 * 108:2603 "settings-offline", 9:258 "settings-saved"). Client state only (a flag in the session store, ADR 0008): the settings themselves are server data.
 * It lives outside any one screen because the quiet-hours screen closes the moment its save is sent, and the answer arrives on the Settings screen.
 */
export type SettingsNotice =
  | { kind: 'saved'; change: SettingChange }
  | {
      kind: 'failed';
      /** 'offline': nothing was sent (or the device could not reach the server). 'error': the server or the network refused or never answered. */
      reason: 'offline' | 'error';
      /** What the person tried to set, so "Try again" can send exactly that. */
      change: SettingChange;
      /** The value that is back (or never left), for "Previous value: ...". Null when it is not known. */
      previous: SettingChange | null;
      /** The server's support reference, when it gave one. */
      requestId: string | null;
    };
