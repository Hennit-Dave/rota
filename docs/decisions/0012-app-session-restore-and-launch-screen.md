# 0012: App sign-in, verified session restore, and the launch screen

- **Status:** accepted (2026-10-22; Dave approved the plan and its six defaults)
- **Date:** 2026-10-22
- **Decided by:** Dave
- **Related:** ADR 0005 (tokens), ADR 0008 (Zustand), ADR 0009 (Expo Router), `.agents/rules/app-state.md`, `docs/STATE.md`, Figma "03 Authentication" and "Motion"

## Problem

The app needs sign-in and sign-up screens, a way to decide at launch whether the stored session still works, and the launch animation the
design specifies. Several small choices affect security (where a password lives), correctness (what "signed in" means after a restart) and
how the app feels on a slow connection.

## Options considered

1. **What "signed in" means at launch.** (a) Tokens exist, so signed in (the scaffold's placeholder). (b) Tokens exist and `GET /auth/me`
   succeeds, refreshing once if needed; offline or unreachable keeps the session.
2. **How sign-in and sign-up call the API.** (a) TanStack `useMutation`. (b) Plain async functions with the form in component state.
3. **How the signed-in and signed-out sides are separated.** (a) A redirect in each screen. (b) Expo Router `Stack.Protected` on the session status.
4. **How the launch animation relates to the native splash.** (a) Follow Figma's 180 x 120 mark. (b) Scale it to the native splash mark. (c) Enlarge
   the native mark (a native rebuild, and Android 12+ would crop it).
5. **How the overlay ends.** (a) Let the animation finish. (b) Fade it out the moment the app is ready, touches passing through.

## Decision

1b, 2b, 3b, 4b, 5b.

## Why

- **1b:** (a) shows the signed-in side for a session the server may have ended, and the first request then bounces the user. (b) is the rule
  `app-state.md` already states for refresh failures: a refused session signs out, an unreachable server keeps it.
- **2b:** a mutation keeps its variables in the in-memory mutation cache, and a password must never sit there (`security.md`).
- **3b:** one place decides which side exists, so a link or the back button cannot reach a screen on the wrong side.
- **4b:** the native mark is 504/1024 of a 200 dp image, about 98 dp. Option (a) makes the mark jump on every launch; (c) needs a rebuild and is
  cropped. The cost is a mark smaller than the spec's. Pinned by a test.
- **5b:** the spec says the launch screen never adds waiting time.
- **A finding worth keeping:** on Android, disabling or blurring the focused input hands focus to the page's `ScrollView`, which draws its default
  focus highlight over the whole page (a 7% dim). `focusable={false}` is not honoured by `ScrollView`, and a zero-size view cannot take focus in touch
  mode, so a submit moves focus to a hidden input (`FocusSink`). An accessible, full-screen overlay triggers the same highlight, so the launch
  overlay announces "Loading" instead of being focusable.

## Consequences

- Restore costs one request at launch (`GET /auth/me`, about 1.1 s cold on the development machine), covered by the launch screen.
- Offline at launch shows the signed-in side with its own offline state and Retry; there is no cached name until the offline-shifts slice.
- A password that is on the common list is only rejected once the blocklist exists (ADR 0005); the app maps `password_common` and it is tested,
  but the real server does not send it yet.
- The Figma copy for "signed out while offline" promised that signing in ends the old session. It does not; only Log out of all devices does. The
  copy was changed (and Figma updated) so the screen does not mislead.
- Log out of all devices does not sign out locally when the server cannot be reached, so the user is never told every device is ended when it is not.
- **Revisit when:** the native splash image or `imageWidth` changes (the metrics test will fail), the real home needs the user before restore finishes,
  or a native rebuild allows disabling the default focus highlight app-wide.

## Evidence

Unit tests (`app/`, `npm test`): code-to-copy mapping, validation, sign-in and sign-up flows including the epoch discard, restore outcomes,
logout and log out of all devices, launch timings and geometry against the Figma numbers, the launch phase rules, and the splash size.
Emulator, against the local API on the TEST databases (`rota_test_a`, `rota_test_b`): every state in the PR description, with screenshots, plus the server
log lines for `session_revoked` (`logout` and `logout_all`) and the real 429 after five wrong logins.
