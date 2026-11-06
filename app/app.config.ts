import fs from 'node:fs';
import path from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import palette from './src/theme/palette.json';

/**
 * Everything here that touches native code (package name, scheme, intent filters, plugins, icons, notification
 * settings) is compiled into the Android build. Changing any of it means a new native build (expo-builds.md),
 * so change it in batches.
 */

// Invite, magic-link, reset and Checkout-return links are https App Links on this host. The OS verifies them
// against https://<host>/.well-known/assetlinks.json (hosted later). Until it is hosted the links open in the
// browser, and the rota:// scheme still works.
const APP_LINK_HOST = 'rota.davebuilds.design';
const APP_LINK_PATHS = ['/invite', '/magic', '/reset', '/checkout'];

// Firebase client config for push (FCM). EAS Build gets it as the file env var GOOGLE_SERVICES_JSON; a local build
// uses ./google-services.json when present. Without either, the app still builds but cannot register for push.
function googleServicesFile(): string | undefined {
  const fromEnv = process.env.GOOGLE_SERVICES_JSON;
  if (fromEnv) return fromEnv;
  const local = path.join(__dirname, 'google-services.json');
  return fs.existsSync(local) ? './google-services.json' : undefined;
}

// Permissions the app does not use, removed from the merged manifest (audited on the merged release manifest, ADR 0011).
// Kept on purpose: INTERNET, ACCESS_NETWORK_STATE and ACCESS_WIFI_STATE (connectivity), POST_NOTIFICATIONS, VIBRATE, WAKE_LOCK,
// com.google.android.c2dm.permission.RECEIVE (FCM push), RECEIVE_BOOT_COMPLETED (so local reminders can be rescheduled later).
const BLOCKED_PERMISSIONS = [
  // Storage: nothing reads or writes shared storage (the offline database is in the app's private folder).
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  // Dev menu overlay: development builds declare it themselves in their debug manifest; a release build must not.
  'android.permission.SYSTEM_ALERT_WINDOW',
  // No biometric prompt feature (secure-store's biometric option is not used).
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  // Play install-referrer service, pulled in by a library, not used.
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
  // Launcher badge counts (Samsung, Sony, HTC, Huawei, Oppo and others), pulled in by expo-notifications. Rota sets no badge count.
  'android.permission.READ_APP_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.android.launcher.permission.INSTALL_SHORTCUT',
  'com.android.launcher.permission.READ_SETTINGS',
  'com.android.launcher.permission.UNINSTALL_SHORTCUT',
  'com.android.launcher.permission.WRITE_SETTINGS',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Rota',
  slug: 'rota',
  owner: 'hennitdave',
  version: '0.1.0',
  scheme: 'rota',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  backgroundColor: palette.paper,
  platforms: ['android'],
  android: {
    package: 'design.davebuilds.rota',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      // Android 13+ themed icons: the system tints this layer's shape (alpha only), so its colour does not matter.
      monochromeImage: './assets/adaptive-icon-monochrome.png',
      backgroundColor: palette.teal,
    },
    googleServicesFile: googleServicesFile(),
    blockedPermissions: BLOCKED_PERMISSIONS,
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: APP_LINK_PATHS.map((pathPrefix) => ({ scheme: 'https', host: APP_LINK_HOST, pathPrefix })),
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: palette.teal,
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 200,
        // The mark is white on teal in light and dark mode alike, so there is no separate dark variant.
        backgroundColor: palette.teal,
      },
    ],
    // ADR 0010: plain SQLite, no SQLCipher. The sqlite-vec extension ships a prebuilt vec.so that is NOT 16 KB
    // aligned, so withSQLiteVecExtension must never be turned on.
    [
      'expo-sqlite',
      { useSQLCipher: false, android: { withSQLiteVecExtension: false } },
    ],
    // Installed now so the first native build includes it. Configured (organization, project) in the Sentry slice.
    '@sentry/react-native',
  ],
  // Created with `eas init` on 2026-10-21 under the hennitdave Expo account. An identifier, not a secret; push token registration needs it.
  extra: {
    eas: { projectId: 'eacd20b3-8817-465d-aabd-ee081e7d6bc7' },
  },
  experiments: {
    typedRoutes: true,
  },
});
