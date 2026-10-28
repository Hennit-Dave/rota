import { onlineManager, skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getSettingsApi, meQueryKey } from '../services';
import { useSessionStore } from '../state/sessionStore';
import type { AuthUser } from '../auth/authResponses';
import { createSettingMutationOptions, maySaveSetting } from './settingsMutation';
import {
  settingMutationKey,
  settingsKey,
  type SettingChange,
  type SettingKey,
  type SettingValue,
  type Settings,
  type ThemeSetting,
} from './settingsResponses';

/**
 * The signed-in user's settings: server data, personal, so the key carries the user ID (app-state.md). Stale at once (`staleTime: 0`, docs/STATE.md): the
 * focus manager (React Native `AppState`) refetches it whenever the app comes back to the foreground, and it is refetched when a screen mounts, so a
 * change made on another device appears here without reinstalling (brief Requirement 7). `networkMode: 'always'` so offline it fails at once instead of
 * pausing for ever; a failed refetch keeps the copy already held. The signed-in layout keeps one observer on it, so it is fetched and kept fresh on every
 * screen, and the theme follows it.
 */
export function useSettings(userId: string | undefined) {
  return useQuery({
    queryKey: settingsKey(userId ?? ''),
    enabled: userId !== undefined,
    networkMode: 'always',
    staleTime: 0,
    queryFn: ({ signal }) => getSettingsApi().get(signal),
  });
}

/** The theme choice, read from the cache without fetching ('system' until the settings are known). Used by the root layout to pick the colours. */
export function useThemeSetting(): ThemeSetting {
  const me = useQuery<AuthUser>({ queryKey: meQueryKey, queryFn: skipToken });
  const settings = useQuery<Settings>({ queryKey: settingsKey(me.data?.id ?? ''), queryFn: skipToken });
  return settings.data?.theme.value ?? 'system';
}

/** Whether THIS field's change is still on its way: its control stays disabled until it settles (app-state.md: one pending change per field). */
export function useIsSettingPending(userId: string | undefined, key: SettingKey): boolean {
  return useIsMutating({ mutationKey: settingMutationKey(userId ?? '', key) }) > 0;
}

/** Whether any setting's change is on its way (the Saving header). */
export function useIsAnySettingPending(userId: string | undefined): boolean {
  return useIsMutating({ mutationKey: ['settings', userId ?? ''] }) > 0;
}

/**
 * Change ONE setting. Checks connectivity first: offline, nothing is sent (not queued, not resumed later) and the person is told at once. Otherwise the
 * optimistic update with rollback runs (`createSettingMutationOptions`). Returns what happened: 'started' (a request is on its way), 'offline' (nothing was
 * sent and the notice says so) or 'busy' (this field's last change is still on its way, nothing was sent).
 */
export function useChangeSetting<K extends SettingKey>(userId: string | undefined, key: K) {
  const client = useQueryClient();
  const setNotice = useSessionStore((s) => s.setSettingsNotice);
  const mutation = useMutation(createSettingMutationOptions(client, userId ?? '', key, getSettingsApi, setNotice));
  const pending = useIsSettingPending(userId, key);

  const change = useCallback(
    (value: SettingValue<K>): 'started' | 'offline' | 'busy' => {
      if (userId === undefined) return 'busy';
      const settings = client.getQueryData<Settings>(settingsKey(userId));
      const gate = maySaveSetting({ online: onlineManager.isOnline(), pending });
      if (gate === 'busy') return 'busy';
      if (gate === 'offline') {
        const previous = settings?.[key];
        setNotice({
          kind: 'failed',
          reason: 'offline',
          change: { key, value } as SettingChange,
          previous: previous ? ({ key, value: previous.value } as SettingChange) : null,
          requestId: null,
        });
        return 'offline';
      }
      mutation.mutate(value);
      return 'started';
    },
    [client, key, mutation, pending, setNotice, userId],
  );

  return { change, pending };
}
