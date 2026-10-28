import type { MutationOptions, QueryClient } from '@tanstack/query-core';
import { ApiError, OfflineError } from '../api/errors';
import type { createSettingsApi } from './settingsApi';
import type { SettingsNotice } from './settingsNotice';
import {
  sameValue,
  settingMutationKey,
  settingsKey,
  settingsMutationPrefix,
  type SettingChange,
  type SettingField,
  type SettingKey,
  type Settings,
  type SettingValue,
} from './settingsResponses';

type Api = Pick<ReturnType<typeof createSettingsApi>, 'change'>;

/**
 * The options of ONE setting's change: an optimistic update with rollback (app-state.md, brief Requirements 2 and 7). One mutation per FIELD, so a
 * theme change that fails never undoes a quiet-hours change that succeeded meanwhile.
 * 1. `onMutate` cancels what is in flight for the settings, keeps THAT FIELD as it was, and shows the new value at once (the control is disabled by the
 *    screen while this runs: `useIsMutating` on this field's mutation key);
 * 2. `onError` puts back ONLY this field, and only if it still holds the value this change set (a refetch that already brought the server's value is not
 *    undone), and tells the person;
 * 3. `onSuccess` takes only this field from the server's answer, and `onSettled` asks the server again once no other setting is on its way, so the
 *    guess never stays: the server's value always replaces it.
 * Never queued offline and never retried: `networkMode: 'always'` and `retry: 0`, no mutation `scope`; the mutation cache is never persisted and paused
 * mutations are never resumed. The screen checks connectivity before it calls this (`maySaveSetting`). The optimistic `updatedAt` is the one the server
 * last gave: the app never makes a timestamp. A factory over plain dependencies so the whole lifecycle is tested without a screen.
 */
export function createSettingMutationOptions<K extends SettingKey>(
  client: QueryClient,
  userId: string,
  key: K,
  api: () => Api,
  notify: (notice: SettingsNotice | null) => void,
): MutationOptions<Settings, unknown, SettingValue<K>, { previous: SettingField<SettingValue<K>> | undefined }> {
  const queryKey = settingsKey(userId);
  const change = (value: SettingValue<K>) => ({ key, value }) as SettingChange;
  const withField = (settings: Settings | undefined, next: SettingField<SettingValue<K>>): Settings | undefined =>
    settings ? ({ ...settings, [key]: next } as Settings) : undefined;

  return {
    mutationKey: settingMutationKey(userId, key),
    networkMode: 'always',
    retry: 0,
    mutationFn: (value) => api().change(change(value)),
    onMutate: async (value) => {
      await client.cancelQueries({ queryKey, exact: true });
      const current = client.getQueryData<Settings>(queryKey);
      const previous = current?.[key] as SettingField<SettingValue<K>> | undefined;
      if (previous) client.setQueryData<Settings>(queryKey, withField(current, { value, updatedAt: previous.updatedAt }));
      notify(null);
      return { previous };
    },
    onError: (error, value, context) => {
      const current = client.getQueryData<Settings>(queryKey);
      const field = current?.[key] as SettingField<SettingValue<K>> | undefined;
      // Only this field, and only if it still holds this change's value. If a refetch already replaced it, the server's value stands.
      if (context?.previous && field && sameValue(field.value, value)) client.setQueryData<Settings>(queryKey, withField(current, context.previous));
      notify({
        kind: 'failed',
        reason: error instanceof OfflineError ? 'offline' : 'error',
        change: change(value),
        previous: context?.previous ? change(context.previous.value) : null,
        requestId: error instanceof ApiError ? error.requestId : null,
      });
    },
    onSuccess: (answer, value) => {
      // Only this field of the answer: another field's guess may still be on its way, and a whole-settings answer would overwrite it.
      const current = client.getQueryData<Settings>(queryKey);
      client.setQueryData<Settings>(queryKey, current ? withField(current, answer[key] as SettingField<SettingValue<K>>) : answer);
      notify({ kind: 'saved', change: change(value) });
    },
    onSettled: () => {
      // This mutation still counts itself while its own callbacks run, so "nobody else is pending" is at most 1.
      if (client.isMutating({ mutationKey: settingsMutationPrefix(userId) }) <= 1) void client.invalidateQueries({ queryKey, exact: true });
    },
  };
}

/**
 * Whether a setting may be changed now. Offline it never is (Figma 108:2613: "Settings need a connection and aren't saved for later"): the change is
 * not sent, not queued and not resumed later (app-state.md tests 12 and 14). While this field's change is on its way its control is off.
 */
export function maySaveSetting(state: { online: boolean; pending: boolean }): 'yes' | 'offline' | 'busy' {
  if (state.pending) return 'busy';
  return state.online ? 'yes' : 'offline';
}
