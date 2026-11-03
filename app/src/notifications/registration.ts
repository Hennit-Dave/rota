/**
 * Registering this phone for push (ADR 0032). Plain functions over a small platform interface, so the order of the steps is unit-tested without a phone.
 *
 * The order matters on Android 13 and later: the notification CHANNEL must exist before the permission is asked for, and a push that names a channel the phone
 * does not have is dropped silently (found in step 0). The token is only fetched once the person has allowed notifications. The token and the permission
 * prompt's outcome are never logged.
 */
export const PUSH_CHANNEL_ID = 'default';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface PushPlatform {
  ensureChannel(): Promise<void>;
  permission(): Promise<PermissionStatus>;
  requestPermission(): Promise<PermissionStatus>;
  /** The Expo push token of this install. Throws if Expo or Google cannot issue one (no Play services, no project id, offline). */
  getToken(): Promise<string>;
}

export interface DevicesApi {
  register(expoToken: string): Promise<void>;
  unregister(expoToken: string): Promise<void>;
}

export type RegisterResult = { status: 'registered' } | { status: 'no_permission' } | { status: 'failed' };

export async function registerThisDevice(deps: { platform: PushPlatform; api: DevicesApi; warn?: (event: string) => void }): Promise<RegisterResult> {
  const { platform, api } = deps;
  try {
    await platform.ensureChannel();
    let status = await platform.permission();
    if (status === 'undetermined') status = await platform.requestPermission();
    if (status !== 'granted') return { status: 'no_permission' };
    await api.register(await platform.getToken());
    return { status: 'registered' };
  } catch {
    deps.warn?.('push_registration_failed');
    return { status: 'failed' };
  }
}

/**
 * Sign-out: tell the server to stop sending this phone the signed-in person's notifications. Best effort and never throws: a failure must not stop the sign-out
 * (the server's own checks, and Expo's DeviceNotRegistered, are the backstop). A phone that never allowed notifications has nothing registered.
 */
export async function unregisterThisDevice(deps: { platform: PushPlatform; api: DevicesApi; warn?: (event: string) => void }): Promise<void> {
  try {
    if ((await deps.platform.permission()) !== 'granted') return;
    await deps.api.unregister(await deps.platform.getToken());
  } catch {
    deps.warn?.('push_unregister_failed');
  }
}
