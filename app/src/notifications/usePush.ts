import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { getDevicesApi } from '../services';
import { useSessionStore } from '../state/sessionStore';
import { parsePushData, routeFor } from './pushTarget';
import { expoPlatform } from './expoPlatform';
import { registerThisDevice } from './registration';

/**
 * The hooks that connect push to the signed-in screens (ADR 0032). Everything decided is in `registration.ts` and `pushTarget.ts`, which have unit tests; the Expo
 * calls are in `expoPlatform.ts`. Mounted by the signed-in layout, so it runs only while someone is signed in.
 */

/** Registers this phone with the server once a person is signed in (and again if a different person signs in). */
export function useRegisterPush(userId: string | undefined): void {
  useEffect(() => {
    if (!userId) return;
    void registerThisDevice({ platform: expoPlatform, api: getDevicesApi() });
  }, [userId]);
}

/**
 * Tapping a push opens the right screen, whether the app was closed (the response that launched it) or already open. Only a known shape is acted on
 * (`parsePushData`); the team is selected through the same store the team list already corrects if the person is not a member of it.
 */
export function usePushTaps(): void {
  const router = useRouter();
  useEffect(() => {
    const handled = new Set<string>();
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = `${response.notification.request.identifier}:${response.notification.date}`;
      if (handled.has(id)) return;
      handled.add(id);
      void Notifications.clearLastNotificationResponseAsync();
      const target = parsePushData(response.notification.request.content.data);
      if (!target) return;
      useSessionStore.getState().selectTeam(target.teamId);
      router.push(routeFor(target));
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [router]);
}
