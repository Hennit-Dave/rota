# app/ — mobile rules (additive to the root AGENTS.md)

These add to the root `AGENTS.md`; they never replace it. If they conflict, stop and ask.
All paths below are relative to the repository root.

**Loading check:** if asked for this folder's rules marker, answer `app-rules-loaded`. The marker exists
only in this file.

## Read before changing code here

| If the change touches… | Read |
|---|---|
| Fetching, caching, persisting or changing data; settings; offline shifts; sign-out | `.agents/rules/app-state.md` |
| Any dependency, `app.json`, `eas.json`, push, deep links, Sentry | `.agents/rules/expo-builds.md` |
| Tokens, login, magic links, invites | `.agents/rules/security.md` |
| Anything that shows a price, charge or payment status | `.agents/rules/money.md` (no money logic in the app) |

## App-specific checks before every PR

- No arithmetic on amounts and no plan prices anywhere in `app/`. Every figure comes from a server response.
- Persist tokens only in secure-store; never put them in query caches, general device storage or logs.
- No new `EXPO_PUBLIC_` variable without a line in `SECURITY.md` saying why it's safe.
- **Assess every new or changed dependency and config change:** does it need a new native build? If it
  does, say so and wait for "go" before installing. If it doesn't, say why (e.g. pure JavaScript).
- Only the allowlisted query is persisted; settings and swap mutations never queue offline.
- Opening a deep link never consumes a token; returning from Checkout triggers a server status check.
- Every list has loading, empty, end-of-list and error states.

## Decided (the three that were pending)

Client state: Zustand (ADR 0008). Offline storage: `expo-sqlite`, plain (ADR 0010). Routing and deep links:
Expo Router, scheme `rota`, App Links on `rota.davebuilds.design` (ADR 0009). The first-build native list and the
16 KB audit are ADR 0011.

## Layout and commands

`app/src/app/` routes (Expo Router) · `api/` client, errors, config · `auth/` epoch, token store, sign-out ·
`state/` the Zustand store · `theme/` design tokens mirrored from Figma · `ui/` components · `services.ts` the only
place real instances are wired. Config is `app.config.ts` (TypeScript); `android/` is generated and gitignored.

Run from `app/`: `npm ci` · `npm run typecheck` · `npm test` (Node's test runner, no device) · `npx expo-doctor` ·
`npm run start` (dev server for the development build). A local build and install is `cd android && ./gradlew
app:assembleDebug -PreactNativeArchitectures=arm64-v8a` after `npx expo prebuild --platform android --no-install`
(see the README for the JDK and Android SDK it needs).

## Design source

Figma file: Rota — the approved screens, components and design tokens. Ignore the "Prototype / …"
frames and the 85:* duplicates. Handoff notes in the file list every screen and its number.

- Foundations (colours, type, spacing): https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=0-1
- Components (buttons, inputs, nav, status, icons): https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=2-2
- 03 Authentication: https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=8-2
- 04 Calendar & activity: https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=7-2
- 05 Team: https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=8-177
- 06 Swaps: https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=8-292
- 07 Billing (Stripe test mode): https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=9-2
- 08 Notifications: https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=9-337
- 09 Settings: https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY/Rota?node-id=9-205

Rules:
- Build a screen inside the slice that needs it, together with its server endpoint. No screen-only
  slices with fake data.
- Reuse the Figma components and variables. Never hard-code a colour, size or font the file defines
  as a token.
- Input labels sit above the field, never inside it.
- If a design and a rules file disagree (for example, a screen that implies the app calculates money),
  the rules win. Stop and tell Dave.