# 0009: Routing and deep links: Expo Router

- **Status:** accepted (2026-10-21)
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** issue #10, `.agents/rules/expo-builds.md`, `.agents/rules/security.md`

## Problem

The app needs screens, navigation and deep links: invites, magic links, password reset, notification taps and the return
from Stripe Checkout. The URL scheme and the Android intent filters are compiled into the build, so the routing choice has to be
made before the first native build.

## Options considered

1. **React Navigation (used directly):** the library Expo Router is built on. Routes are declared in code, and every deep link
   needs a hand-written linking config that must be kept in step with the screens.
2. **Expo Router:** routes are the files in `app/src/app/`, and a file is automatically reachable by URL, so a deep link to a
   screen needs no separate mapping. It is the default for Expo apps and supports typed routes. It sits on
   `react-native-screens` and `react-native-safe-area-context`, which are native modules.

## Decision

Expo Router (`expo-router` ~58.0.25). Android only. Routes live in `app/src/app/`.

## Why

- One place defines a screen and its URL, so the deep-link rules in `security.md` (the link opens a screen; only the app's
  explicit `POST` consumes a token) are enforced by what each screen does, not by a second routing table that can drift.
- Notification taps can carry a URL and be routed the same way as a link, with the app closed or already open.

## Deep links set in this decision (compiled into the build; changing any needs a new native build)

- **Scheme:** `rota` (for example `rota://invite/<token>`).
- **Android App Links (https, `autoVerify`):** host `rota.davebuilds.design`, path prefixes `/invite`, `/magic`, `/reset`,
  `/checkout`. The prefixes cover invite, magic link, reset and the Checkout return; Dave confirmed them on 2026-10-21 and asked that they match
  as **path prefixes**, so `/invite/<token>` works (verified on the emulator, ADR 0011). Adding a path later is a rebuild.
- **Verification is not live yet.** Android verifies App Links against `https://rota.davebuilds.design/.well-known/assetlinks.json`,
  which is hosted in a later slice (it needs the signing certificate's fingerprint, known only after the first EAS build).
  Until then the https links open in the browser and the `rota://` scheme works.
  **Update 2026-10-26:** the host is GitHub Pages, with the EAS keystore's fingerprint (ADR 0019).
- **DNS check (Dave, 2026-10-21):** nothing sits directly on `rota.davebuilds.design`. The existing records are `send.rota` and
  `rsend.rota` (Resend, CNAME) and `_dmarc.rota` (TXT), on Cloudflare (free plan). Serving a page or file at the apex of
  `rota.davebuilds.design` needs a new record there, and it must not disturb the Resend records.
- **Package name:** `design.davebuilds.rota`.

## Consequences

- Opening a link never consumes a token (`security.md`): the screens a link lands on show a confirmation and only a `POST` from
  the app redeems anything. Those screens come with the invite and magic-link slices.
- Returning from Stripe Checkout triggers a server status check, never proof of payment (`app/AGENTS.md`).
- **Revisit when:** a link path is needed that the four prefixes do not cover (a rebuild), or the link host changes.

## Evidence

The generated Android manifest contains the `rota` scheme and the four verified-intent filters (see ADR 0011, Evidence). Link
verification itself is pending the `assetlinks.json` slice.
