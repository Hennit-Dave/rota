import { parseTime } from '../shifts/shiftTime';
import { settingsCopy } from './settingsCopy';
import type { SettingsNotice } from './settingsNotice';
import type { QuietHours, SettingChange, SettingKey, ThemeSetting } from './settingsResponses';

/** The words for each setting (Figma 9:205). Display only. */
export const settingLabel: Record<SettingKey, string> = {
  quietHours: 'Quiet hours',
  timeZone: settingsCopy.timeZoneLabel,
  notifyShiftChanges: 'Shift changes',
  notifySwapUpdates: 'Swaps',
  notifyBilling: 'Billing',
  language: settingsCopy.languageLabel,
  theme: 'Theme',
};

export const themeLabel = (theme: ThemeSetting): string => settingsCopy.themes[theme];
export const languageLabel = (code: string): string => settingsCopy.languages[code] ?? code;
export const onOff = (on: boolean): string => (on ? settingsCopy.on : settingsCopy.offValue);

/** "22:00 – 07:00" when quiet hours are on, "Off" when they are not (Figma 9:209). */
export function formatQuietHours(q: QuietHours): string {
  return q.enabled ? `${q.start} – ${q.end}` : settingsCopy.quietHours.off;
}

/** One value as the screens say it: "Previous value: ...", and the line under "Quiet hours saved". */
export function describeChange(change: SettingChange, context: { timeZone?: string | null } = {}): string {
  switch (change.key) {
    case 'quietHours': {
      const hours = formatQuietHours(change.value);
      return change.value.enabled && context.timeZone ? `${hours} · ${context.timeZone}` : hours;
    }
    case 'timeZone':
      return change.value ?? settingsCopy.timeZoneUnset;
    case 'theme':
      return themeLabel(change.value);
    case 'language':
      return languageLabel(change.value);
    case 'notifyShiftChanges':
    case 'notifySwapUpdates':
    case 'notifyBilling':
      return onOff(change.value);
  }
}

/** The title and the line under it: they change with what is happening (Figma 108:128 saving, 9:289 error, 108:2603 offline, 9:258 saved). */
export function settingsHeader(input: { saving: boolean; notice: SettingsNotice | null; timeZone?: string | null }): { title: string; subtitle: string } {
  const { saving, notice } = input;
  if (saving) return { title: settingsCopy.saving.title, subtitle: settingsCopy.saving.subtitle };
  if (notice?.kind === 'failed') {
    return notice.reason === 'offline'
      ? { title: settingsCopy.offline.title, subtitle: settingsCopy.offline.subtitle }
      : { title: settingsCopy.failed.title, subtitle: settingsCopy.failed.subtitle };
  }
  if (notice?.kind === 'saved') {
    return { title: `${settingLabel[notice.change.key]} ${settingsCopy.saved.titleSuffix}`, subtitle: describeChange(notice.change, { timeZone: input.timeZone }) };
  }
  return { title: settingsCopy.title, subtitle: settingsCopy.subtitle };
}

export interface QuietHoursForm {
  start: string;
  end: string;
}

export interface QuietHoursCheck {
  /** Both as the server wants them ("HH:MM", two digits), when both are fine. */
  values: { start: string; end: string } | null;
  errors: { start?: string; end?: string };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Checks what was typed before it is sent. A convenience only: the server checks again and refuses anything else (a refusal shows as the failed state).
 * "9:00" is accepted and sent as "09:00".
 */
export function checkQuietHours(form: QuietHoursForm): QuietHoursCheck {
  const start = parseTime(form.start);
  const end = parseTime(form.end);
  const errors: QuietHoursCheck['errors'] = {};
  if (!start) errors.start = settingsCopy.quietHours.timeInvalid;
  if (!end) errors.end = settingsCopy.quietHours.timeInvalid;
  if (!start || !end) return { values: null, errors };
  const values = { start: `${pad(start.hour)}:${pad(start.minute)}`, end: `${pad(end.hour)}:${pad(end.minute)}` };
  if (values.start === values.end) return { values: null, errors: { end: settingsCopy.quietHours.sameTime } };
  return { values, errors };
}
