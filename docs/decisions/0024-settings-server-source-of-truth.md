# 0024: Settings: the server is the source of truth, each setting has its own server-set updatedAt

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-28
- **Decided by:** Dave (plan and answers 2026-10-28: `user_settings` approved plus `notify_billing`; three notification types; language `en` only; theme overrides removed and checked on the device; time zone NULL until chosen; Figma 09 Settings frames; issue #19 closed as a duplicate of #24). The two settings rate limits and the three changes from the approved SQL, below, are **proposals awaiting Dave's approval**.
- **Related:** slice S2, issues #24 and #19, brief Requirement 7 and interview question 6, `.agents/rules/app-state.md` (optimistic updates, tests 3 to 6, 12 to 14), `.agents/rules/jobs.md` (quiet hours), `data.md`, `security.md`, ADR 0008 (client state), Figma 09 Settings (9:205)

## Problem

A nurse manager sets quiet hours on her phone. If they live only on the phone, the server cannot honour them at 2am, and her tablet still buzzes with its old copy. The settings must live on the server, every device must show the server's copy, two devices changing the same thing must have a clear winner, and a change must feel instant but undo itself, only for that setting, if the server says no.

## Options considered

1. **Where the settings live.** (a) On each device, synced by the app: the server cannot enforce them. (b) **On the server, the app holds a copy that is replaced by the server's.** Chosen (brief).
2. **One row per user with a version, or one `updatedAt` per setting.** (a) One timestamp for the whole row: a theme change on the phone would lose to a quiet-hours change on the tablet that arrived a moment later. (b) **One server-set `updatedAt` per setting, one setting per request.** Chosen: a theme change and a quiet-hours change made on two devices both survive.
3. **Conflict rule.** (a) Last writer wins by the server's clock on arrival (the brief's rule). (b) A version the client sends back, refusing a stale write (compare-and-set): kinder to the user, but a conflict screen is not in Figma and the brief names the first. **(a) chosen**, weakness documented below.
4. **Quiet hours as one setting or three.** (a) Three (`enabled`, start, end): a start from one device and an end from another could combine into a window nobody chose. (b) **One setting, written together.** Chosen.
5. **Offline changes.** (a) Queue them and send later: the server stamps on arrival, so a change made last week would overwrite a newer one from another device. (b) **Never queue: offline, the change fails at once and rolls back.** Chosen (`app-state.md`), and the answer to interview question 6.

## Decision

**Table.** `user_settings`, one row per user, created by the first change (a `GET` with no row answers the defaults and writes nothing). It is identity data on shard A, with a real foreign key to `users` and `ON DELETE CASCADE`; the migration runs on both shards like every migration, but only A holds rows. Migration `20261028150000_add_user_settings`.

Three changes from the SQL Dave approved, each tightening it:
- **A server-set `*_updated_at` for each notification type**, not one shared `notifications_updated_at`. The brief says each setting has its own, and with a shared one the reported time for "shift changes" would move when "billing" changed. (`notify_billing` is the column Dave added.)
- **`CHECK (quiet_hours_start <> quiet_hours_end)`**: equal times mean neither "never" nor "always"; the API refuses it too.
- **`CHECK (theme IN ('system','light','dark'))`** was in the approved SQL; `language` has no database check, the API's allowlist (`en`) is the rule, so adding a language needs no migration.

**API.** `GET /settings` and `PATCH /settings`, user routes: Zod, access token and session check, the per-user rate limit, handler. The user is the signed-in one; there is no way to name someone else's settings, and no team or role is involved. `PATCH` takes exactly **one** field (a union of single-key strict objects): `quietHours {enabled,start,end}`, `timeZone`, `notifyShiftChanges`, `notifySwapUpdates`, `notifyBilling`, `language`, `theme`. A client-sent `updatedAt`, a user ID, two settings or an unknown key is `400`. The change is one `INSERT … ON CONFLICT DO UPDATE` that sets the value and `<field>_updated_at = clock_timestamp()` in the database: the stamp is when that value was actually written (after the row lock), not when the request started, and never the client's. The answer is every setting as `{ value, updatedAt }`, `null` meaning never changed. Settings are read on the primary (identity data, `data.md`) and are never cached in Valkey: the push job must see the live value. `Cache-Control: no-store`.

**Rate limits (proposed, chosen, not measured; awaiting approval).** `settings_read_user` 120 per minute (mirrors the feed; every foreground refetch is one read) and `settings_write_user` 30 per minute. Both per user, fail closed with `503` when Valkey is down. Env: `RATE_LIMIT_SETTINGS_READ_USER_*`, `RATE_LIMIT_SETTINGS_WRITE_USER_*`.

**Notification types.** Shift changes, swap updates, billing (Dave). Billing is inert until payments exist; its row is shown to an Owner of the selected team, as in Figma ("Billing · Owner only"), using the role the server returned.

**Language.** `en` only, stored and synced. There are no translations, so the picker has one option and the weakness is documented (`STATE.md`).

**Time zone.** `NULL` until the person chooses. Until then the push job uses the team's time zone (below). The app shows "Choose your time zone" and says so. The app never auto-saves the device's zone: that would be a write the person did not make, and a tablet in another country would override it.

**Where quiet hours will be enforced (push slice, not built here).** (1) The push job calls one pure function, `decide(settings, now, urgent)`, that returns "send" or `delayUntil`; it will live in `server/src/settings/`. (2) The job re-reads the user's current settings and time zone when it runs (`jobs.md`). (3) A `PATCH` of `quietHours` or `timeZone` will, in the same transaction, reschedule that user's `pending` and `claimed` push rows (generation bump, clear the claim, `jobs.md`). No push rows exist yet, so nothing in this PR does (1) to (3); the app's copy is display only.

**The app.**
- One query, `['settings', userId]`, `staleTime: 0`. The focus manager (React Native `AppState`) refetches it when the app returns to the foreground, and the signed-in layout keeps an observer on it, so a change made on another device appears on every screen. A failed refetch keeps the copy already held.
- **One mutation per field** (`settingsMutation.ts`): `onMutate` cancels the settings query, keeps that field, shows the new value at once (with the `updatedAt` the server last gave: the app never makes a timestamp); `onError` puts back **only that field, and only if it still holds this change's value**, and says so; `onSuccess` takes only that field from the answer; `onSettled` refetches once no other setting is on its way (otherwise the refetch would flash another pending field's old value). That field's control is disabled while it is pending (`useIsMutating` on its mutation key). `networkMode: 'always'`, `retry: 0`, no mutation `scope`, the mutation cache is never persisted and paused mutations are never resumed. Connectivity is checked before `mutate`: offline, nothing is sent.
- Screens follow Figma 09: Settings (the Preferences card, time zone, language, "Account & sessions"), Quiet hours, and the saving, saved, failed and offline states, which are shown on the Settings screen itself (the quiet-hours screen closes when its save is sent, so a save is never announced before the server has answered). The old `/account` screen is now `/account/sessions`.
- Two small deviations from Figma, both because a design gap would otherwise lose a requirement: the quiet-hours screen has a "Turn quiet hours off" button (Figma shows only Save, and `enabled` needs a switch); and the "notification-settings" frame (rows "Swap requests", "General updates", with a Save button) is **not built**: it predates the agreed types, so the three types are switches in the Preferences card, saved one at a time like every other setting.

**Theme (issue #24, #19).** The theme is a per-user server setting: `system` (follow the device), `light` or `dark`. It cannot exist before sign-in, so the signed-out screens stay light-only (`ColorsOverrideProvider`, an override that always wins). The forced-light wrapper is **removed from every signed-in screen** (Dave); the colours come from the setting (`ThemePreferenceProvider` in the root layout, read from the settings cache). Two things make that safe: `Icon` is theme-aware by default (the artwork bakes the light token colours, `themeStrokes` swaps each for the current theme's, identical in light), and the launch screen waits for the first settings answer of a signed-in session so the first frame is already in the person's theme (offline or a failed request ends the wait; the request has no retries). Figma has dark frames for Schedule (owner and staff), Team activity, Swap review and Settings; the other screens use the same tokens but have no dark frame. **Which of them look wrong in dark is checked on the device by Dave**; any that break go back behind the override and are listed in `STATE.md`.

## Why

- Per-field stamps and one-field requests are what make "the most recent change wins" mean something per setting; a row-level stamp would have the tablet's quiet-hours change silently undo the phone's theme.
- The stamp is taken in the database with `clock_timestamp()` after the lock, so two writes to one field are ordered by when they were really applied.
- The never-queue rule is what makes the simple last-writer-wins safe: a delayed write is the only way an old change could beat a newer one from another device.

## Consequences

- **The weakness (written down on purpose).** "Most recent" is the order the requests ARRIVE in, not the order the person made the changes. If the phone's change is slow (a bad connection) and the tablet's change, made later, arrives first, the phone's older change arrives last and wins. Nothing tells either device. Per-field requests limit the damage to the one field, and the refetch on foreground shows the winner on every device. A compare-and-set with a version would fix it, at the cost of a conflict state the design does not have.
- **Interview question 6** (quiet hours changed offline on the phone, then on the tablet; which wins?): the phone's offline change never reaches the server, because it is not queued: it fails at once and rolls back. The tablet's change is the only one the server saw, so it stands. Had we queued the phone's change, it would arrive later and, being the last arrival, would overwrite the tablet's.
- A device whose clock is wrong does not matter: no client time is ever used.
- **Switching the theme repaints the whole tree**, including re-reading every icon's artwork. On the emulator, in a development build, the colours followed the
  optimistic value after about 0.8 s (to Light) and 2.5 s (to System): the row already shows the new value, the page catches up. Not measured on a release
  build.
- Quiet-hours and time-zone enforcement are not in this PR (they land with push). Until then the settings are stored and shown but nothing is held back.
- The launch screen can now last as long as the settings request (at most the API client's 15 s timeout, the same ceiling as the session check); in practice it overlaps with the check of the session.
- The Settings screen cannot show Billing for someone who owns one team and is Staff in another unless that team is selected: the row follows the selected team's role, the value is one per person.
- Revisit: a compare-and-set version if the weakness bites; a second language when translations exist; the real shard migration on Dave's go.

## Evidence

See the PR description: the `PATCH /settings` request and response, `SELECT * FROM user_settings`, the test commands, and the screenshots.
