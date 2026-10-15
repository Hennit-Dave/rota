---
trigger: model_decision
description: "Read before adding, removing or upgrading any app dependency, changing app.json or app.config, eas.json, deep-link schemes, push notification setup, Sentry for the app, the Expo SDK version, or anything that might need a new EAS development build."
---

# Expo and native builds

If a rule here conflicts with `AGENTS.md`, stop and ask. The checks at the end are the acceptance criteria.

## Why a development build (brief)

- Remote push notifications don't work in Expo Go on Android, so Rota runs as an **EAS development build**
  (Expo's cloud build service). **Android only**: iOS device builds need a paid Apple Developer account.
- The development build is a deliverable: its download link goes in `SUBMISSION.md` (brief). It loads
  JavaScript from a development server, so on its own it isn't something a reviewer can test.
- **For independent testing, also produce a preview build:** an installable APK that runs **without a
  development server**, pointed at the deployed backend. `SUBMISSION.md` links both and says which to use
  for what.
- **[Self-study: EAS Build]** On first touch, prompt Dave's own-words `LEARNING-LOG.md` entry.

## Builds are scarce

- Dave's free Expo plan gives a limited number of Android builds a month on a low-priority queue. **Use
  the allowance shown in the Expo dashboard**, not an assumed number. Preview builds count too.
- **Before proposing anything that needs a new native build, say so, say why, and wait for "go".** Batch
  native changes so one build covers them.
- Record each build in the PR that needed it: date, profile, reason.

## What needs a new build, and what doesn't

| Needs a new native build | Doesn't (reloads from the dev server) |
|---|---|
| Adding, removing or upgrading any package with native code | JavaScript and TypeScript changes |
| Changing native config in `app.json` / `app.config`: plugins, permissions, package name, URL scheme, notification settings | Styles, screens, logic, API calls |
| Changing the Expo SDK version | Adding a pure-JavaScript package |

If unsure whether a package has native code, check its docs before installing, and treat "unsure" as
"needs a build".

## Install native dependencies before the first build

The list below comes from the rules files. **Before the first build, confirm each one, record the final
list in an ADR, and install with `npx expo install` so versions match the Expo SDK. Never invent a version.**

| Need | Candidate | Source rule |
|---|---|---|
| Development build | `expo-dev-client` | brief |
| Push notifications | `expo-notifications` (plus whatever its docs require for project ID and device checks) | brief, `jobs.md` |
| Token storage | `expo-secure-store` | `AGENTS.md` rule 4 |
| Connectivity for offline rules | `@react-native-community/netinfo` | `app-state.md` |
| Persisted offline shifts | Storage chosen in `STATE.md` (pending) | `app-state.md` |
| Error tracking | `@sentry/react-native` (Expo integration) | `observability.md` |
| Feed list | `@shopify/flash-list` **v2: JavaScript-only, no native dependencies**; check its React Native architecture requirement when picking the version | brief |
| Deep links: invites, magic links, notification taps, Checkout return | Routing and linking choice (pending), with the URL **scheme** set in config | brief, `security.md` |
| Opening Stripe Checkout and returning to the app | `expo-web-browser` | `money.md` |
| Device time zone for settings | `expo-localization` | brief (Requirement 7) |

## Before the first build: config checklist

- `app.json`: Android package name, URL scheme, notification icon and colour, and **config plugins where a
  module's installation instructions require them**.
- `eas.json`: a **development** profile (development client enabled, internal distribution) and a
  **preview** profile (internal distribution, APK, no development client, deployed API URL). Both produce
  an installable Android file with a download link.
- **Android push credentials:** Expo push on Android goes through Firebase Cloud Messaging; follow Expo's
  current push setup docs. `google-services.json` holds public-facing identifiers and may be committed.
  **The service-account private-key JSON is a secret: upload it to EAS credentials, never commit it.**
- `EXPO_PUBLIC_` variables (e.g. the API base URL, the Sentry DSN) are public by design; each one is listed
  in `SECURITY.md` with why it's safe. Secrets never go there.
- The Sentry source-map upload token is a build-time secret (EAS secret), never `EXPO_PUBLIC_`.

## Acceptance checks (on a real Android device)

1. **Before building:** the dependency checklist above was reviewed and recorded in the ADR. (A later,
   justified rebuild isn't a failure.)
2. The development build installs and loads from the dev server. **The preview APK installs and runs with
   no dev server**, against the deployed backend.
3. A push token registers with the server after login.
4. A notification sent **from a server job** arrives, and tapping it opens the exact screen (brief) —
   tested with the app **closed** and **already open**.
5. Invite and magic-link deep links open the right screen without consuming anything (`security.md`) —
   with the app closed and already open.
6. **Returning from Stripe Checkout triggers a server status check.** Coming back to the app never counts
   as proof of payment; only the server's answer does (`money.md`).
7. **Tokens are only in secure-store; persisted shifts contain only the approved fields.**
8. **Offline after a restart:** load shifts, close the app completely, go offline, reopen → upcoming shifts
   show with their "last updated" time, and mutations fail immediately (`app-state.md`).
