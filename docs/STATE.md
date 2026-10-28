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
| The caller's teams (`['teams', userId]`: id, name, timeZone, role) | TanStack Query | Server data, personal, so the key carries the user ID (`app-state.md`). Seeded with the server's answer when a team is created **or an invitation is accepted**, then refetched (`refetchType: 'all'`, because it never refetches on mount); sign-out clears the whole cache | TanStack defaults (`staleTime` 0, `gcTime` 5 min), `refetchOnMount: false` like `['me']`: refetched when the app returns to the foreground, not on every visit. No number invented; set properly with the real home | No |
| Selected team ID | Zustand | Client-only choice. An ID only: the server checks membership on every request (`security.md`). Set when a team is created, **when an invitation is accepted (the accepted team, so "lands in the right team" holds for someone already in another)**, and whenever the server's list arrives: kept while the server still lists that team, else the first listed (oldest), else none (`pickSelectedTeamId`) | n/a | **No, decided in the Teams and roles slice.** It is rebuilt from `GET /teams` on every launch, and a stored ID could point at a team the user has since left. Revisit when there is a team picker (a user in several teams) |
| The invitation link's token (`<teamId>.<secret>`) | The route (`/invite/[token]`), in memory, then as route params to login and signup | It is a credential. **Never** in secure-store, AsyncStorage, Zustand (reset on every sign-out), a TanStack key, a log or a screenshot. Carried to login and signup only so the person can be sent back to the same invitation once the session starts (ADR 0017). Sentry, when added, must scrub route params | n/a | No |
| What an invitation is for (`['invite-preview', screenId, counter, signedIn or signedOut]`) | TanStack Query | Server data (`POST /invitations/preview`, which consumes nothing). **The secret is not in the key**: the key is the screen's own ID plus a counter that moves when the token does, so a new link on the same screen is fetched again. It refetches when the session changes (signed in, so the server can compare the account) and when the app returns to the foreground | `staleTime` 0 and `gcTime` 0: an invitation can be revoked or used at any moment, so it is never reused and is dropped when the screen leaves. `networkMode: 'always'` so it fails at once when offline instead of pausing for ever; runs only while its screen is focused. A request that starts is bounded by the 15 s client timeout | No |
| Accepting an invitation (`POST /invitations/accept`) | A TanStack mutation (`networkMode: 'always'`, `retry: 0`) behind a synchronous latch | Never queued or retried (`app-state.md`). The latch refuses a second tap before React has re-rendered, so three quick taps send one request. On success the accepted team is written into `['teams', userId]` **from the accept answer**, selected, and the list refetched (`applyAcceptedTeam`) | n/a | No |
| What the caller may do in a team (`['team', userId, teamId]`) and who is in it (`['members', userId, teamId]`) | TanStack Query | Server data (`GET /teams/:teamId`, which carries `invitableRoles`, `canManageInvitations` and `canEditShifts` from the server's permission table, and `GET /teams/:teamId/members`). Personal, so the keys carry the user ID and the team ID. The app shows what the server allows and decides nothing | TanStack defaults (`staleTime` 0, `gcTime` 5 min): a roster changes whenever someone joins, so it refetches on mount and when the app returns to the foreground. No number invented. `networkMode: 'always'`, so offline it fails at once into the offline state instead of pausing for ever | No |
| The team's pending invitations (`['invitations', userId, teamId]`) | TanStack Query | Server data (`GET /teams/:id/invitations`, oldest first), asked for only when the server has said this person may list them (`canManageInvitations`): a Staff member would be refused. Each row carries the server's `emailStatus` (`queued`, `sent`, `failed`) and `canResend` and `canRevoke`, which decide which buttons exist. The directory previews the oldest one and the pending screen shows all of them from the same cache entry | TanStack defaults (`staleTime` 0, `gcTime` 5 min): an invitation's email state moves from queued to sent or failed without the app doing anything, so it refetches on mount and when the app returns to the foreground, and it is invalidated after a send, a resend and a revoke. No polling and no number invented. `networkMode: 'always'` | No |
| Resend and Revoke | Two TanStack mutations (`networkMode: 'always'`, `retry: 0`), each behind a synchronous latch | Never queued offline. While one action runs every action on the screen is disabled and the running one shows the spinner (Figma note 232:415). Revoke asks first (its own screen); the route carries only the invitation's ID and the address is read from the server's list | n/a | No |
| Invite form fields (address, chosen role, whether the role sheet is open), and the invitation just sent | Component state (`useState`) | One screen; not secret. The roles offered are exactly the server's `invitableRoles` (never Owner), and a stale choice the server no longer offers is never sent. The "Invitation sent" screen holds the server's answer in component state; the pending list that reads it from the server comes in the next step | n/a | No |
| Sending or resending an invitation | A TanStack mutation (`networkMode: 'always'`, `retry: 0`) behind a synchronous latch (`ui/latch.ts`) | Never queued offline (`app-state.md`). The latch refuses a second tap before React re-renders, so three quick taps create one invitation (shown on the emulator). The email itself is sent later by the worker, so the app only ever says "Email queued" | n/a | No |
| Create-team form fields (name, time zone) | Component state (`useState`) | Not secret and used by one screen. The create call is a TanStack mutation with `networkMode: 'always'` and `retry: 0`: it runs and fails at once offline, and is never queued or resumed (`app-state.md`) | n/a | No |
| The time zone list (`app/src/teams/timeZones.ts`) | A fixed list in the app | Display data only, no logic. It is Node 24's `Intl.supportedValuesOf('timeZone')` (the server's runtime), so every entry is accepted; a test keeps it a subset. Hermes' support for that function is not relied on | n/a | n/a (ships with the app) |
| Sign-out notice (`none`, `session_ended`, `revoke_unconfirmed`) | Zustand (UI flag) | Tells the signed-out side which screen to open first: `/session-ended`, `/signed-out-offline`, or `/login`. Cleared on sign-in and when the user moves on | n/a | No |
| Account epoch | A plain in-memory counter (`app/src/auth/epoch.ts`) | Not UI state and must be readable from non-React code. Discards results that belong to a previous account | n/a | No, on purpose |
| Launch overlay phase (`launch`, `loading`, `done`) | Component state in `LaunchGate` | Derived from "has the session been restored" and one timer. Pure rules in `app/src/motion/launchPhase.ts`, unit-tested. Not in Zustand: nothing else reads it | n/a | No |
| Connectivity | NetInfo, fed into TanStack's `onlineManager` | The rules need one answer to "are we online" for queries and for the API client | n/a | No |
| App in foreground | React Native `AppState`, fed into TanStack's `focusManager` | Refetch when the app returns to the foreground (settings across devices, later) | n/a | No |
| Theme (light/dark) | Follows the device for now | Becomes a per-user server setting in the settings slice. Auth screens stay light-only (forced with `ColorsOverrideProvider`) because the setting does not exist before sign-in (issue #24) | n/a | n/a |
| The schedule: shifts of one week (`['shifts', userId, teamId, 'range', from, to, 'mine'\|'all']`) and one shift (`['shifts', userId, teamId, 'one', shiftId]`) | TanStack Query | Server data (`GET /teams/:id/shifts`, `…/shifts/:shiftId`). Personal and team-scoped, so the keys carry the user ID and the team ID and sign-out clears them. One request per week (the server caps a range at 42 days); the single shift opens from the week already held, then the server's answer replaces it. A create, edit or delete drops every cached range (`invalidateQueries` on the `['shifts', userId, teamId]` prefix) | TanStack defaults (`staleTime` 0, `gcTime` 5 min): a manager can publish at any moment, so nothing shows a week the server may no longer agree with; it refetches on mount and on return to the foreground. No number invented. `networkMode: 'always'`, so offline it fails at once into the offline state. The three writes never queue offline and never retry | No (saved shifts arrive with the offline slice, which will persist only the upcoming-shifts query below) |
| The team's activity feed (`['activity', userId, teamId]`) | TanStack Query (`useInfiniteQuery`) | Server data (`GET /teams/:id/activity`, pages of 20 by the server's cursor). Personal and team-scoped, so the key carries the user ID and the team ID and sign-out clears it. The pages and the cursor each was fetched with live inside the one entry; the cursor is the server's opaque string, handed back unchanged. A shift create, edit or delete invalidates it (every shift write also wrote a feed row) | TanStack defaults (`staleTime` 0, `gcTime` 5 min): the feed is what just happened, so it refetches on mount and on return to the foreground. Pull to refresh keeps only the first page and refetches it (not every page loaded). No number invented. `networkMode: 'always'`, so offline it fails at once into the error state. "Try again" resets the query, so a paused or cancelled one starts from nothing | No (saved data arrives with the offline slice, which persists only the upcoming-shifts query) |
| The swaps (`['swaps', userId, teamId]`, and `[…, 'one', swapId]`) | TanStack Query | Server data (`GET /teams/:id/swaps`): the caller's own swaps and, for someone who may decide, the waiting ones. Personal and team-scoped, so the key carries the user ID and the team ID and sign-out clears it. **"Send swap request" is an optimistic update with rollback** (`swapMutation.ts`): `onMutate` cancels the in-flight list, keeps it, and puts a guess on top (it grants no action); `onError` puts the list back exactly (or removes it if there was none); `onSuccess` replaces the guess with the server's answer; `onSettled` refetches. The control is off while it is pending, and connectivity is checked before `mutate`. Cancel, approve and reject are not optimistic (the server decides what happens to two people's shifts) and also drop the shifts and the feed | TanStack defaults (`staleTime` 0, `gcTime` 5 min): a request can be decided at any moment, so it refetches on mount and on return to the foreground. No number invented. `networkMode: 'always'` and `retry: 0` on every swap mutation, no mutation `scope`, the mutation cache is never persisted and paused mutations are never resumed: offline the request fails at once and nothing is queued (app-state tests 12 and 14). The idempotency key lives only in the confirm screen's memory (one per request) | No |
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

## The launch screen (`app/src/ui/LaunchGate.tsx`, `app/src/motion/`)

The Shift-swap mark from the Figma Motion page covers the restore. Its rules, each tested in `app/src/motion/motion.test.ts`:

- **It never adds waiting.** The app is rendered underneath the moment it is ready; the overlay fades out over 150 ms and ignores touches, so
  nothing waits for the animation. Ready early means a cut to the app, not a finished swap.
- **It plays only while the session restores:** one swap and back (1.08 s), on the teal of the native splash.
- **Past one cycle it hands over to the Loading mark** (the teal fades to the app background so the teal-and-grey mark can be seen).
- **Reduce motion** (`AccessibilityInfo.isReduceMotionEnabled`): no movement. Launch shows the static mark; Loading shows the static mark
  with a visible "Loading…" label and no spinner.
- **Size.** The animation starts at the size of the native splash mark (about 98 dp), not the 180 x 120 in Figma, so the mark does not jump
  between the two. Pinned by `launchMetrics.test.ts` to `app.config.ts` and the splash PNG.

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

## Teams (`app/src/teams/`, `app/src/app/(app)/`)

- **Create team** (Figma 8:101) is where sign-up lands and where a signed-in user with no team is sent from home. The creator becomes the Owner;
  the server generates the team ID. Presence is checked on tap; the length limit and the valid time zones are the server's (`400` details come
  back as field messages, the 80 is the server's number). The button says "Create team" and Figma's "Next step" banner is left out until the
  billing slice (Dave's decision; Figma still shows "Continue to plan selection").
- **Home** shows the selected team's name (and "ROTA / TEAM NAME" in the eyebrow, as in Figma). It is server data (`GET /teams`): loading, an error
  with Retry, and "no team" (which goes to create-team) are all handled.
- The time zone is chosen from a searchable list (a plain React Native modal, no new native module); the phone's own zone is the starting choice only
  if it is on the list.

## Known weaknesses (written down on purpose)

- **Create team has no idempotency key.** A network retry after a lost answer could create a second team. The button is disabled while the request is
  out, the app never retries it, and the server limits a user to 5 new teams an hour (ADR 0014).
- **The create-team screen is light-only for now,** like the auth screens: Figma's chevron artwork carries its colour, and the theme becomes a per-user
  server setting in the settings slice (issue #24).

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
