---
trigger: model_decision
description: "Read before writing app code that fetches, caches, persists or changes data: TanStack Query queries and mutations, optimistic updates and rollback, swap requests, settings sync across devices, offline upcoming shifts, the client state tool, the API client and token refresh, or STATE.md."
---

# App state (brief, Requirement 2 and Requirement 7)

If a rule here conflicts with `AGENTS.md`, stop and ask. The tests at the end are the acceptance criteria.
The server decides everything that matters; the app displays what the server allows (`AGENTS.md`). No
money logic in the app (`money.md`).

## Where data lives

| Kind | Where | Examples |
|---|---|---|
| Server state | **TanStack Query**, for all server data (brief) | shifts, members, feed, settings, billing figures |
| Client state | **One** client state tool, **pending Dave's choice** (Zustand or React state), justified in `STATE.md` | open tab, form drafts |
| Persisted state | TanStack Query persister, allowlisted queries only | upcoming shifts for offline viewing |
| Secrets | `expo-secure-store` only | access and refresh tokens |

- **`STATE.md` maps every important piece of data** to where it lives, why, its cache times, and whether
  it is persisted. It's updated in the same PR as any change to that data (brief).
- Query keys always include the team ID and every parameter that shapes the response, and **the user ID
  for any response that is personal** (it differs by who is asking).
- Cache times (`staleTime`, `gcTime`) are chosen per kind and **explained in `STATE.md`** (brief). Never an
  unexplained number.

## API client and tokens

- One API client attaches the access token, reads the response's request ID for Sentry, and handles 401.
- **Only one refresh in flight** (`security.md`): concurrent 401s wait for the same refresh.
- **What a failed refresh means decides what happens:**
  - **The server says the session is invalid, expired or revoked** (401 from the refresh endpoint): sign
    out fully (below).
  - **Offline before the request was sent:** keep the session and the saved shifts; allow offline viewing;
    try again when connectivity returns.
  - **Sent, but the response was lost** (timeout, connection dropped): don't replay it automatically. Under
    strict rotation (`security.md`) the old token may already be consumed, so the next refresh attempt is
    expected to fail as reuse; that 401 then signs the user out. Saved shifts stay readable until then.

## Signing out and switching accounts

**Explicit logout, online:** first ask the server to revoke the current session (`security.md`), then do
the local steps below. *Why: otherwise a copied refresh token stays usable.* **Offline, or the revoke call
fails:** do the local steps immediately anyway, and tell the user the server session couldn't be confirmed
as ended (document this in `STATE.md`). A server-confirmed invalid session skips the revoke call.

Local steps, for every full sign-out:
1. Bump an in-memory **account epoch**. Every request and every persistence write captures the epoch when
   it starts; a result arriving under an older epoch is discarded, never written to any cache.
2. Cancel in-flight queries; clear the **in-memory query cache and mutation cache**.
3. Stop the persister, delete the persisted cache, and restart it with the next user's buster.
4. Delete tokens from secure-store.

*Why: clearing device storage alone leaves the previous user's data in memory, and a slow request or a
delayed persistence write could restore it.*

## Optimistic updates with rollback (brief: swap requests and settings)

1. `onMutate`: cancel in-flight queries for the affected keys, snapshot the current data, apply the
   optimistic change, and disable the triggering control.
2. `onError`: restore the snapshot and show an error message (brief: "the label reverts with an error").
3. `onSettled`: invalidate the affected queries so the server's version replaces the guess.

- **Double-submit protection is two layers:** the disabled control, and a client-generated idempotency key
  per swap request that the server stores, so a retry after a timeout never creates a second swap.
  *Why: a disabled button doesn't stop a network retry.*
- The optimistic value is always replaced by the server's response; the app never treats its guess as
  final.

## Settings across devices (brief, Requirement 7)

- Settings live on the server: quiet hours, time zone, notification types, language, theme (brief).
- **Each setting has its own `updatedAt`, set by the server** (brief). Updates are per field, so changing
  the theme on a phone and quiet hours on a tablet both survive.
- **Conflict rule (brief): most recent change wins**, where "most recent" means the server's receipt time
  for that field.
- **Other devices see changes** by refetching settings when the app opens and when it returns to the
  foreground (TanStack `focusManager` wired to React Native `AppState`).
- **Settings changes and swap requests are never queued offline.** Disabling retries isn't enough:
  TanStack Query's default network mode can pause an offline mutation and run it after reconnecting. So:
  - wire TanStack's `onlineManager` to the device's connectivity, and **check connectivity before
    calling `mutate`**: offline → fail immediately, roll back, say so;
  - give these mutations `networkMode: 'always'` and `retry: 0`, so they run and fail instead of pausing
    (the docs describe this mode for queries; the test below confirms it for mutations);
  - **never persist the mutation cache and never call `resumePausedMutations()`.**

  *Why: a change sent later would overwrite a newer change made on another device, because the server
  stamps it on arrival.*
- **One pending change per field, and rollback per field.** Each settings field is its own mutation.
  **That field's control is disabled until its mutation settles**, and connectivity is checked again
  immediately before each send. Don't use TanStack mutation `scope` here: it queues later mutations and
  runs them automatically, which is the delayed write this file forbids. On failure, restore **only that
  field**, and only if its current value is still the one this mutation set. *Why: restoring a
  whole-settings snapshot would undo a different field that changed successfully meanwhile.*
- **Document the weakness in `STATE.md`:** last-writer-wins follows arrival order, not the user's intent;
  a slow request can still overwrite a newer one on the same field. Interview question 6 answer: the
  phone's offline change never reached the server, so the tablet's change stands.
- The server enforces quiet hours and time zone itself (`jobs.md`); the app's copy is only for display.

## Offline upcoming shifts (brief)

- Persist **only** the upcoming-shifts query (allowlist), never other queries, tokens, or billing data.
- Show a visible **"last updated" time** from the query's last successful fetch (brief).
- The persisted cache has a maximum age (config, in `STATE.md`) and a buster that includes the user ID, so
  another account never sees it. It is **cleared on logout** and on any forced sign-out.
- **Shift data is personal information; persist only the fields needed for offline viewing and document
  the storage protection.** The persister's device storage is chosen in `STATE.md`; if it or the
  connectivity library has a native module, it is installed before the first EAS build (`expo-builds.md`).
- Offline, mutations fail fast with a clear message. There is no offline mutation queue (not in the brief).

## Lists (brief, Requirement 1)

- The feed uses `useInfiniteQuery` with the server's cursor and FlashList (or FlatList with a written
  reason), plus pull to refresh.
- Fetch the next page only when `hasNextPage && !isFetchingNextPage`, so fast scrolling never sends
  duplicate requests (brief).
- Loading, empty, end-of-list and error states are all designed (brief). Details: `cursor-pagination` skill.

## Tests (acceptance criteria)

1. **Optimistic swap:** "Swap requested" shows immediately and the control disables; a server error
   restores the label and shows the error.
2. **No double swap:** a double tap plus a retried request after a timeout → one swap on the server.
3. **Settings rollback:** a failed settings change restores the previous value with a message.
4. **Cross-device:** change a setting on device A; bring device B to the foreground → B shows it.
5. **Per-field conflict:** theme changed on A and quiet hours on B → both kept.
6. **Interview question 6:** an offline change on the phone fails and rolls back; the tablet's change
   stands on the server.
7. **Offline shifts:** in airplane mode the upcoming shifts show with their "last updated" time; no other
   query was persisted.
8. **Logout clears memory and storage:** after logout, the query cache, mutation cache and persisted shifts
   are empty.
9. **Account switch mid-request:** sign out while account A's request is in flight, sign in as B → A's
   response is discarded and never appears in B's caches or storage.
10. **Single refresh:** several simultaneous 401s trigger one refresh call.
11. **Refresh failure types:** offline → session and saved shifts kept; server 401 → full sign-out;
    a lost response is not replayed automatically.
12. **No delayed offline write:** change a setting offline → immediate error and rollback → reconnect → no
    request reaches the server. Same for a swap request.
13. **Overlapping settings changes:** change the theme (pending), change quiet hours (succeeds), then the
    theme request fails → theme rolls back, quiet hours keep the new value.
14. **Connectivity lost while a change is pending:** while a theme change is in flight, go offline → the
    theme control stays disabled until it settles; a new change attempted offline fails immediately; after
    reconnecting, no additional queued request is sent. (A request already sent before the
    connection dropped may still complete on the server; losing the connection can't undo it.)
15. **Logout revokes:** online logout → the old refresh token is rejected by the server. Offline logout →
    local data is gone at once and the user is told revocation wasn't confirmed.
16. **Feed paging:** fast scrolling sends no duplicate page requests; all four list states render.
