import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PermissionStatus, PushPlatform } from './registration';

/** The real Expo side of push (ADR 0032): the calls to the phone, behind the `PushPlatform` interface that `registration.ts` is tested against. */

const asStatus = (s: Notifications.NotificationPermissionsStatus): PermissionStatus => (s.granted ? 'granted' : s.canAskAgain ? 'undetermined' : 'denied');

/** The project id Expo needs to issue a token. An identifier, not a secret (app.config.ts). */
function projectId(): string {
  const id = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (typeof id !== 'string' || id.length === 0) throw new Error('no_project_id');
  return id;
}

export const expoPlatform: PushPlatform = {
  async ensureChannels(channels) {
    if (Platform.OS !== 'android') return;
    // The server names one of these in every push; a channel the phone does not have drops the message silently. Setting an existing channel again changes nothing
    // the person set (their own mute or sound choices are theirs).
    for (const channel of channels) {
      await Notifications.setNotificationChannelAsync(channel.id, { name: channel.name, importance: Notifications.AndroidImportance.DEFAULT });
    }
  },
  async permission() {
    return asStatus(await Notifications.getPermissionsAsync());
  },
  async requestPermission() {
    return asStatus(await Notifications.requestPermissionsAsync());
  },
  async getToken() {
    return (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data;
  },
};

// A push that arrives while the app is open is shown like any other (SDK 58 shows it by default; this makes that explicit). No sound, no badge.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});
