# State

Where every important piece of data in the mobile app lives, and why. Required by the brief (Requirement 2) and
`.agents/rules/app-state.md`. **Updated in the same PR as any change to this data.** Status: **started** in PR B (app scaffold);
rows marked *planned* are filled in by the slice that builds them.

## The three kinds of state

| Kind | Tool | Why |
|---|---|---|
| Server state | TanStack Query (5.104.5) | Everything the server owns: shifts, members, feed, settings, billing figures. It fetches, caches, refetches and rolls back. |
| Client state | **Zustand** (5.0.15), one store | Only what exists on the phone and is not secret: session status, selected team, UI flags. Reasons and the sign-out gap it fills: ADR 0008. |
| Persisted state | expo-sqlite, plain (*planned*) | Upcoming shifts for offline viewing only. Reasons and protection: ADR 0010. |
| Secrets | `expo-secure-store` | Access and refresh tokens, nothing else. |

## Map of the data

| Data | Lives in | Why there | Cache times | Persisted? |
|---|---|---|---|---|
| API health result (`['health']`) | TanStack Query | It is server data (a diagnostic probe) | `staleTime` 0, `gcTime` 60 s: a health check is only worth anything if it is fresh, so it always refetches and is dropped quickly | No |
| Access token and refresh token | `expo-secure-store`, one item `rota.session` holding both | `AGENTS.md` rule 4. One item so a crash cannot leave tokens from two different refreshes side by side | n/a | Yes, in secure-store only. Never in the query cache, AsyncStorage, a log or backup (Android backup rules exclude secure-store) |
| Session status (`restoring`, `signedOut`, `signedIn`) | Zustand | Client-only. Rebuilt on launch from a **verified** restore (below): stored tokens plus a successful `GET /auth/me`, or tokens kept when the server could not be asked. It also decides which side of the app exists (`Stack.Protected`) | n/a | No |
| The signed-in user (`['me']`: id, email, name, emailVerified) | TanStack Query | Server data. Seeded from the sign-in, sign-up or restore answer, so the placeholder home needs no second request. The key has no user ID because the answer *is* "who am I"; sign-out clears the whole cache, so it cannot leak to the next account | TanStack defaults (`staleTime` 0, `gcTime` 5 min), with `refetchOnMount: false`: it is refetched when the app returns to the foreground, not on every screen visit. No number invented for a placeholder screen; set properly with the real home | No |
| Sign-in and sign-up form fields (name, email, password) | Component state (`useState`) | A password must never sit in the Zustand store, the query cache or a TanStack mutation (which keeps its variables in memory), so sign-in and sign-up are plain async functions, not mutations. Cleared when the screen goes away | n/a | No, and never in a log |
| Selected team ID | Zustand | Client-only choice. An ID only: the server checks membership on every request (`security.md`) | n/a | No (whether it should survive a restart is decided with the team screens) |
| Sign-out notice (`none`, `session_ended`, `revoke_unconfirmed`) | Zustand (UI flag) | Tells the signed-out side which screen to open first: `/session-ended`, `/signed-out-offline`, or `/login`. Cleared on sign-in and when the user moves on | n/a | No |
| Account epoch | A plain in-memory counter (`app/src/auth/epoch.ts`) | Not UI state and must be readable from non-React code. Discards results that belong to a previous account | n/a | No, on purpose |
| Connectivity | NetInfo, fed into TanStack's `onlineManager` | The rules need one answer to "are we online" for queries and for the API client | n/a | No |
| App in foreground | React Native `AppState`, fed into TanStack's `focusManager` | Refetch when the app returns to the foreground (settings across devices, later) | n/a | No |
| Theme (light/dark) | Follows the device for now | Becomes a per-user server setting in the settings slice. Auth screens stay light-only (forced with `ColorsOverrideProvider`) because the setting does not exist before sign-in (issue #24) | n/a | n/a |
| Upcoming shifts, "last updated" time | TanStack Query + persister over expo-sqlite (*planned*) | Offline viewing | *planned*: set in the offline-shifts slice, with the maximum age | *planned*: allowlisted fields only, cleared on logout |
| Settings (quiet hours, time zone, notification types, language, theme) | TanStack Query, server is the source (*planned*) | Server-owned, per-field `updatedAt` | *planned* | No |

Cache times are tuned per kind of data and every number added later needs a row here with its reason. The only default set so far is
`retry`: queries retry at most twice and only when retrying cannot do harm (5xx, network failure, a refused refresh); never a 4xx,
never an uncertain refresh. Mutations do not retry (`app/src/services.ts`, `app/src/api/errors.ts`).

## The API client and tokens (`app/src/api/client.ts`)

- One client attaches the access token, reads `X-Request-Id` from every response (kept on the error, for Sentry later) and handles 401.
- **One refresh in flight.** Concurrent 401s wait for the same refresh. A 401 that arrives after a refresh has already finished
  retries with the newer token instead of refreshing again. Tested with five simultaneous requests: one `POST /auth/refresh`.
- **What a failed refresh means** (ADR 0005; `app-state.md` should match, see the rules diff in PR B):

| Refresh answer | Meaning | What the app does |
|---|---|---|
| `400` or `401` | Session invalid, expired, revoked, reused, or the app sent a malformed token | Full local sign-out. A `400` is also logged as an app bug (no token in the log) |
| `429`, `503` | Refused before the token was touched | Keep the session. Safe to retry |
| Offline before sending | Nothing was sent | Keep the session and any saved data. Try again when connectivity returns |
| Sent, answer lost (timeout, dropped connection, unreadable answer, other 5xx) | The old token may already be consumed | **Never replayed automatically.** Keep the session; the next attempt is expected to fail as reuse and that 401 signs the user out. TanStack is told not to retry it |
| `200` but the new tokens cannot be saved | Old token consumed, new one lost | Sign out |

- Request timeout is **15 s**. This is a chosen ceiling, not a measurement: the server waits up to 5 s to start an auth transaction
  (ADR 0005) and a cold Neon connection was measured at 3.7 s from the development machine. Tune it from real use.
- The base URL must be `https`, except the local development server (`http://10.0.2.2:<port>`, `localhost`) in a development build.

## App start: restoring the session (`app/src/auth/restore.ts`)

The app decides which side to show only after the stored session has been checked with the server. While that runs the status is
`restoring` and neither side exists.

| What happens | Result | Status afterwards |
|---|---|---|
| No tokens on the device (or secure-store unreadable) | `signed_out`, nothing is sent | `signedOut` |
| `GET /auth/me` answers 200 (after one refresh if the access token had expired) | `signed_in` | `signedIn`, `['me']` seeded |
| The refresh is refused (400 or 401), or `/auth/me` is still 401 after a good refresh | `session_ended`, full local sign-out with that notice | `signedOut`, `/session-ended` |
| Offline, timeout, 429, 503, an unreadable answer, or a refresh whose answer was lost | `unverified`: **the session is kept** (never replayed, `app-state.md`) | `signedIn`; home shows its own offline or "couldn't load" state with Retry |

## Signing in and signing up (`app/src/auth/authActions.ts`)

`POST /auth/login` and `POST /auth/register` are public routes: no access token is attached and a 401 there means "wrong credentials",
never a refresh. The answer is parsed, then (1) the epoch captured at the start is checked, so a sign-out or account switch while the
request was out discards it (app-state.md test 9), (2) both tokens are written to secure-store as one item, (3) the epoch is checked
again, and if a sign-out raced the write the tokens are cleared again, (4) only then does the store become signed in. If secure-store
refuses the write the user is not signed in. Errors are mapped by the server's `code` and `details` to Figma's words
(`app/src/auth/authFailure.ts`); the 429 wait is the server's `Retry-After`, only formatted (`app/src/auth/retryWait.ts`).

## Signing out and switching accounts (`app/src/auth/signOut.ts`, `session.ts`)

Order, every time, even if a step throws (the tokens are always deleted):

1. Bump the in-memory **account epoch**. Every request and every refresh captures the epoch when it starts; a result that arrives under
   an older epoch is thrown away (`StaleAccountError`) and never written anywhere. A refresh that finishes after sign-out does not write
   its new tokens, and a refresh refused after sign-out does not sign the next account out.
2. Cancel in-flight queries and clear the query cache and mutation cache.
3. Delete the persisted cache. *Nothing is persisted yet, so this is a no-op until the offline-shifts slice.*
4. Reset Zustand to its initial state, carrying the notice (ADR 0008).
5. Delete the tokens from secure-store.

**Log out of all devices** (`POST /auth/logout-all`) needs the server: offline or failing, it does **not** sign out locally and shows an
error, because signing out without ending the other sessions would tell the user every device is ended when it is not. On success the
five steps run with no notice.

**Explicit logout:** online, the app first asks the server to revoke this device's session (`POST /auth/logout`) so a copied refresh token
stops working, then does the five steps. **Offline, or if the revoke fails,** it does the five steps at once and the notice
`revoke_unconfirmed` tells the user the server could not confirm the session ended. A session the server already called invalid skips
the revoke.

## Known weaknesses (written down on purpose)

- **Android focus highlight.** When a focused input is disabled or blurred, Android hands focus to the first focusable view, the page's
  `ScrollView`, and draws its default focus highlight over the page (a uniform 7% dim). React Native's `focusable={false}` is not honoured by
  `ScrollView` on Android, so a submit parks focus on a hidden input instead (`app/src/ui/FocusSink.tsx`). Revisit if a native rebuild ever
  allows turning the default focus highlight off for the whole app.

- **A lost refresh response forces a new login.** There is no grace window on the server (ADR 0005), so a refresh that succeeded but whose
  answer never arrived looks like reuse on the next attempt. Accepted trade-off.
- **The helper "Use at least 15 characters." under the signup password is display copy**, a mirror of the server's policy (ADR 0005). Error
  messages take their number from the server's `details`; if the policy changes, this copy and the Figma text change with it.
- **A password that is on the common list is only rejected once a list exists:** the production blocklist is empty (ADR 0005), so
  `password_common` is mapped and tested but the real server does not send it yet.
- **Offline logout leaves the server session alive** until it expires or is revoked another way; the user is told.
- *Planned, written when the settings slice lands:* last-writer-wins follows arrival order, not the user's intent, so a slow request can
  overwrite a newer change to the same field.
