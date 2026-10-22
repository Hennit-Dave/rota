# 0011: First native build: Expo SDK 58, the native module list, and the 16 KB page-size audit

- **Status:** accepted (Dave, 2026-10-21): SDK, module list, keeping reanimated/worklets/gesture-handler, `google-services.json`
  handling, link paths, permission blocklist
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** PR B (`feat/app-scaffold`), `.agents/rules/expo-builds.md`, ADRs 0008, 0009, 0010, issues #8, #9, #10

## Problem

EAS development builds are limited (Free plan: 15 Android builds a month, low-priority queue, 0 used this period; the quota resets
about 31 October). `expo-builds.md` requires the whole app's native dependencies to be settled and recorded **before** the first
build, so no feature slice forces a rebuild. The test device is an emulator with a **16 KB memory page size** (Pixel 10a, Android 17,
API 37, arm64), so every native library has to load under 16 KB pages.

## Options considered

1. **Expo SDK 57** (`57.0.31`, released 2026-06-30). Four months old, 31 patches. Its headline changes are mostly iOS 27.
2. **Expo SDK 58** (`58.0.17`, released 2026-09-29, npm `latest`). React Native 0.88.0, React 19.3.0, TypeScript ~6.0.3. Three
   weeks old, 17 patches.

## Decision

**SDK 58** (Dave, 2026-10-21). Versions come from SDK 58's own `bundledNativeModules.json` and were installed with `npx expo install`;
`npx expo-doctor` passes 20/20.

### Native modules in the first build

| Need | Package (version) |
|---|---|
| Core | `expo` ~58.0.17, `react-native` 0.88.0, `react` 19.3.0 |
| Development build | `expo-dev-client` ~58.0.14 (brings `expo-dev-launcher`, `expo-dev-menu`, an ML Kit barcode scanner for its QR login) |
| Routing and deep links (ADR 0009) | `expo-router` ~58.0.25, `react-native-screens` ~4.30.0, `react-native-safe-area-context` ~5.10.1, `expo-linking` ~58.0.14, `expo-constants` ~58.0.13, `expo-status-bar` ~58.0.4, `expo-splash-screen` ~58.0.11, `expo-system-ui` ~58.0.6 |
| Tokens | `expo-secure-store` ~58.0.2 |
| Push | `expo-notifications` ~58.1.6, `expo-device` ~58.0.5 |
| Connectivity | `@react-native-community/netinfo` 12.0.1 |
| Stripe Checkout return | `expo-web-browser` ~58.0.6 |
| Time zone | `expo-localization` ~58.0.5 |
| Errors | `@sentry/react-native` ~8.28.0 (plugin present, unconfigured until the Sentry slice) |
| UI | `expo-font` ~58.0.9, `react-native-svg` 15.16.0 |
| Idempotency keys, install ID | `expo-crypto` ~58.0.7 |
| Copy invite link (Dave, 2026-10-21) | `expo-clipboard` ~58.0.4 |
| Offline shifts (ADR 0010) | `expo-sqlite` ~58.0.13 |
| **Pulled in by `expo-router`, see below** | `react-native-reanimated` 4.7.1, `react-native-worklets` 0.13.0, `react-native-gesture-handler` ~3.3.0 |

Expo's autolinking reported 31 Expo modules in the build (the table plus their own dependencies such as `expo-asset`,
`expo-file-system`, `expo-keep-awake`, `expo-manifests`, `@expo/dom-webview`, `@expo/log-box`).

**JavaScript only, no native code (checked: no `android`, `ios` or `cpp` folder in any package):** `@tanstack/react-query` and
`@tanstack/react-query-persist-client` 5.104.5, `zustand` 5.0.15, `@shopify/flash-list` 2.3.2, `@expo-google-fonts/manrope` and
`@expo-google-fonts/dm-sans` 0.4.2.

**Installed then removed:** `expo-build-properties`. The generated debug manifest already sets `usesCleartextTraffic="true"`, so the
local API over `http://10.0.2.2` works without it.

**Not installed, and why:** `expo-image`, `expo-haptics`, `expo-symbols`, `@expo/ui` (nothing in the Figma pages read needs them).

### reanimated, worklets and gesture-handler are required by `expo-router`

An early plan said these three were optional and would be left out. That was wrong in practice: `expo-router` depends on
`react-native-drawer-layout`, which lists reanimated and gesture-handler as **non-optional peers** (worklets is a peer of
reanimated, and `expo-modules-core` 58 references it too). npm installs them, and Expo autolinking compiles anything in the tree, so
they are in the build whether or not the app uses them directly.

**Decision (Dave, 2026-10-21): keep them**, pinned to the SDK-matched versions (reanimated 4.7.1, worklets 0.13.0, gesture-handler ~3.3.0;
the same set Expo's own template ships). They have no prebuilt libraries and all three pass the 16 KB flag themselves (audit below). It
also leaves the door open to gesture-driven sheets and animations without a rebuild. Excluding them with Expo's autolinking `exclude`
setting was considered and **not tried**: it is off the supported path.

## 16 KB page-size audit (the evidence)

NDK r27b (27.1.12297006, the EAS image for SDK 58) does not align to 16 KB by default, so each library has to opt in. Checked three ways.

1. **Source, exact versions.** The React Native Gradle plugin adds `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` to every library's CMake
   arguments (`NdkConfiguratorUtils.kt:54`); `expo-modules-core`, `expo-sqlite`, `react-native-screens`, `react-native-reanimated`,
   `react-native-worklets` and `react-native-gesture-handler` also pass it; `react-native-svg` and Sentry set
   `-Wl,-z,max-page-size=16384`.
2. **Prebuilt libraries** (read from the ELF headers of the exact downloads): Hermes `hermes-android` 260318099.0.4, `react-android`
   0.88.0, `sentry-native-ndk` 0.16.6: all aligned. **No npm package ships a prebuilt library except `expo-sqlite`'s `vec.so`**
   (sqlite-vec), which is aligned for 4 KB only. It is packaged only when the plugin option `withSQLiteVecExtension` is true. It is
   configured false, and the built app confirms it (`vec_version()` fails). **Never enable it.**
3. **The built APK itself** (local debug build, arm64-v8a, 2026-10-21):
   - `zipalign -c -P 16 -v 4 app-debug.apk` (build-tools 36.0.0): **Verification successful**, 379 entries OK, none failed.
   - All **32** arm64 `.so` files in the APK, read from their ELF program headers: every `LOAD` segment is aligned to **0x4000**
     (16 KB); **0 fail**. The list: `libreactnative`, `libhermesvm`, `libhermestooling`, `libjsi`, `libfbjni`, `libc++_shared`,
     `libappmodules`, `libexpo-modules-core`, `libexpo-modules-jsi`, `libexpo-modules-v2`, `libexpo-modules-worklets`, `libexpo-sqlite`,
     `libreanimated`, `libworklets`, `libgesturehandler`, `librnscreens`, `libreact_codegen_{rnscreens,rnsvg,safeareacontext,rngesturehandler_codegen}`,
     `libsentry`, `libsentry-android`, `libsentry-tm-perf-logger`, and the dev-client's image and barcode libraries.
   - **It runs.** Installed and launched on the 16 KB emulator (`adb shell getconf PAGE_SIZE` prints `16384`, Android 17, API 37, arm64).
     A library that was not 16 KB aligned would fail to load; the app starts, renders, and every native module answers (below).

**Not verified:** x86_64 and 32-bit builds (not built locally; the EAS build produces all ABIs, and only 64-bit matters for 16 KB). The
audit proves the **debug** build. The same libraries go into the EAS build, but the EAS build output itself is checked the same way
(`zipalign -c -P 16` and the ELF scan) before it is installed. No official Expo statement that SDK 58 supports 16 KB was found; the
evidence is source inspection plus the build above.

## Evidence

- **Native modules on the 16 KB emulator** (`app/src/app/dev-check.tsx`, development-only, read from logcat): `expo-secure-store`
  round trip true · `expo-sqlite` 3.53.3, `sqlcipher=false sqlite-vec=absent` · `expo-crypto` UUID length 36 · `expo-device` ·
  `expo-localization` time zone · netinfo `type=wifi connected=true` · `expo-clipboard` · `expo-notifications` (permission not granted) ·
  `expo-web-browser` custom tabs · `expo-linking` `rota://invite/example` · `expo-constants` `scheme=rota` · `expo-system-ui` ·
  `expo-font` both families loaded · Sentry module imports (not initialised) · `react-native-svg` rendered. **14 of 14 OK.**
- **The scheme works:** `adb shell am start -d rota://dev-check` opened that screen in the running app.
- **App to API:** the placeholder screen shows "The API answered: ok." from `GET http://10.0.2.2:3100/health`.
- Screenshots: `/Users/blk/Desktop/rota-pr-b-evidence/` (outside the repo, for the PR description).
- Unit tests: `cd app && npm test` (40 tests), `npm run typecheck`, `npx expo-doctor` (20/20). `python3 app/scripts/check-16kb.py <apk>` reproduces
  the APK checks (tested: passes on the real build, fails on a known 4 KB-aligned library).
- Generated manifest: the `rota` scheme, and an `autoVerify` filter for `https://rota.davebuilds.design` at `/invite`, `/magic`, `/reset`
  and `/checkout`. Link **verification** is pending the `assetlinks.json` slice.

## Build environment notes (what it took, for the next person)

- **JDK:** no system Java. Android Studio's bundled JDK **25** (`/Applications/Android Studio.app/Contents/jbr/Contents/Home`) built the
  app with Gradle 9.4.1 and AGP 9.2.1. EAS uses JDK 17. Not tested on 17 locally.
- **Android SDK:** `ANDROID_HOME=~/Library/Android/sdk`. Gradle downloaded NDK 27.1.12297006 the first time (the same NDK as the EAS image).
- **Expo CLI's `run:android` hung** on its ADB device probe. `gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a` then
  `adb install` worked.
- **Gradle's HTTP client timed out twice** downloading `react-android` (about 290 MB debug AAR) from React Native's mirror, while `curl`
  fetched it fine. Worked around with a local Maven folder for those two modules, written into the generated, gitignored `android/`
  only. A normal network may not need it.
- **Memory:** the first launch froze the emulator ("Process system isn't responding") while the Mac was under memory pressure with four
  Gradle and Kotlin daemons alive. Stopping them fixed it. Run the build, then stop the daemons (`./gradlew --stop`), then launch.
- **Emulator noise:** the Android 17 image's `android.hardware.uwb-service` crash-loops once a second and floods logcat. Filter with
  `adb logcat --pid=$(adb shell pidof design.davebuilds.rota)`.
- npm 12 blocks dependency install scripts by default; `@sentry/cli`'s postinstall was skipped (only needed to upload source maps).
- Metro prints a warning that `expo-router`'s published `package.json` `exports` points at a file that does not exist
  (`router-store`); it falls back to file resolution and the app works. An upstream packaging issue in 58.0.25, not ours.

## App Links: path prefixes (verified on the emulator)

The four paths are Android `pathPrefix` entries, not exact paths, so `/invite/<token>` matches. Checked against the installed build with
`adb shell pm resolve-activity -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d <url> design.davebuilds.rota`:

| URL | Resolves to |
|---|---|
| `https://rota.davebuilds.design/invite/abc123`, `/invite`, `/magic?token=x`, `/reset/abc`, `/checkout/return?session=x` | the app (`MainActivity`) |
| `rota://invite/abc` | the app |
| `https://rota.davebuilds.design/other`, another host, plain `http` | no activity (not ours) |

`app/src/appConfig.test.ts` also fails if a path is changed from a prefix to an exact `path`.

## EAS project and Firebase file (decided)

- **Expo project:** `@hennitdave/rota`, created with `eas init` on 2026-10-21 under the `hennitdave` account (Dave's login owns two accounts,
  `hennit_dave` and `hennitdave`; `hennitdave` was chosen). Project ID `eacd20b3-8817-465d-aabd-ee081e7d6bc7`, recorded in
  `app.config.ts` (`extra.eas.projectId`) with `owner: 'hennitdave'`. An identifier, not a secret. The development build profile uses the
  EAS environment `development`.
- **`google-services.json`** (Firebase project `rota`, Android app `design.davebuilds.rota`): **gitignored** at `app/google-services.json`
  (already moved there). For cloud builds it is the **EAS file variable `GOOGLE_SERVICES_JSON`** (visibility *sensitive*, environments
  `development` and `preview`; created 2026-10-21, value not printed). `app.config.ts` reads the variable on EAS and the local file otherwise.
  Why not committed: the values ship in every APK so they are not secret, but the repository is public, GitHub secret scanning flags
  Google API keys, and the brief's `_KEY` history search would find the key field. The Firebase **service-account private key** is the
  real secret and goes to EAS credentials, never the repo. Consider restricting the API key to the Android app in the Google Cloud console.

## Permission audit (merged manifests, 2026-10-21)

The release manifest as generated declared **34** permissions, most added by libraries (about 25 launcher-badge permissions for Samsung,
Sony, HTC, Huawei, Oppo and others from `expo-notifications`; biometric and install-referrer permissions; storage and overlay from
Expo's template). Rota needs none of those. They are removed with `android.blockedPermissions` in `app.config.ts`, each with its reason:

| Kept (9, all needed) | Why |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | API calls and connectivity (NetInfo) |
| `POST_NOTIFICATIONS`, `VIBRATE`, `WAKE_LOCK`, `com.google.android.c2dm.permission.RECEIVE` | push (FCM) |
| `RECEIVE_BOOT_COMPLETED` | lets local reminders be rescheduled after a reboot, if a later slice adds them (removing it later is a rebuild) |
| `design.davebuilds.rota.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | the app's own, added by AndroidX |

Blocked: `READ/WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW` (release only: the debug manifest declares it itself, and the merged **debug**
manifest still has it), `USE_BIOMETRIC`, `USE_FINGERPRINT`, `BIND_GET_INSTALL_REFERRER_SERVICE`, and the launcher-badge set.
Debug builds additionally carry `ACCESS_LOCAL_NETWORK` and `CHANGE_WIFI_MULTICAST_STATE` (dev-client discovery); release does not.
Exported components in the release manifest: `MainActivity` (launcher and links), Firebase's `FirebaseInstanceIdReceiver` (protected by the
FCM `SEND` permission) and AndroidX's `ProfileInstallReceiver`. `allowBackup` is on, with `expo-secure-store`'s rules excluding its data
from backup. `app/src/appConfig.test.ts` fails if a needed permission is blocked.

## Release builds need a Sentry setting (found by trying)

A **release** Gradle build with the Sentry plugin installed and no auth token fails at the source-map upload step
(`createBundleReleaseJsAndAssets_SentryUpload` ... `sentry-cli` exit 1). Debug builds do not run it, which is why the development build works.
The **preview profile must set `SENTRY_DISABLE_AUTO_UPLOAD=true`** until the Sentry slice provides organisation, project and an EAS token.
The permission audit above needed the same variable to merge the release manifest.

## Image sizes for the final art

Checked against Expo's documentation and Google's adaptive-icon guidance on 2026-10-21. Placeholders are in `app/assets/`; the table is repeated in
`app/assets/README.md`.

| Asset | File | Exact size | Rules |
|---|---|---|---|
| App icon | `assets/icon.png` | **1024 x 1024 px**, PNG | Exactly square (1023 x 1024 is invalid). Fill the whole square, **no rounded corners and no transparent pixels**; the OS applies the mask |
| Adaptive icon foreground | `assets/adaptive-icon.png` | **1024 x 1024 px**, PNG, transparent background | Android layers are 108 x 108 dp. Keep the logo **at most 66 x 66 dp and at least 48 x 48 dp**: on the 1024 px canvas that is **at most about 626 px and at least about 455 px**, centred. The outer 18 dp (about **171 px**) on each side is reserved for masking and parallax. No shadow or mask baked into the layer. The background is the solid colour `palette.teal` in `app.config.ts` |
| Splash mark | `assets/splash-icon.png` | **1024 x 1024 px**, PNG, transparent background (Expo's recommendation) | Shown 200 dp wide (`imageWidth` in `app.config.ts`) on `palette.paper` (light) or `palette.night` (dark). A separate dark-mode image is optional (`dark.image`) |
| Notification icon | `assets/notification-icon.png` | **96 x 96 px**, PNG | **All white on a transparent background** (Android draws it as a silhouette). Tinted `palette.teal` by `app.config.ts` |

Not verified: how Android 12 and later crop the splash mark to a circle. Keep the mark inside the central two-thirds of the canvas to be safe.
Optional, not configured: a monochrome adaptive icon layer for Android 13+ themed icons (it would be a new config entry, so a rebuild).

## Before the first EAS build (still open)

1. **Final art** (Dave designs it in Figma): the four images above. Icons are compiled in, so the art lands before the build.
2. **The build itself**, after this PR merges and the art is in: `eas build --profile development --platform android`. Then run
   `python3 app/scripts/check-16kb.py <downloaded.apk>` on the result before installing it (it runs `zipalign -c -P 16` and the ELF scan).
3. **Sentry:** organisation, project and an EAS source-map token in the Sentry slice (see above for the preview profile).
4. **Preview profile** in `eas.json` once the deployed API URL exists (deployment gate), with `SENTRY_DISABLE_AUTO_UPLOAD=true`.

## Consequences

- One build covers everything the whole app needs, if nothing else with native code turns up.
- Later config changes to anything in `app.config.ts` (package, scheme, intent filters, plugins, icons, notification colour) are rebuilds.
- **Revisit when:** a feature needs a native module not in this list, or the SDK is upgraded.
