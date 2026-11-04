# 0034: Offline upcoming shifts: one route, one saved query, 7 days

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-11-04
- **Decided by:** Dave (plan approved 2026-11-04): the upcoming-shifts route, a 7-day maximum age (chosen, not measured), each person's own shifts only whatever their role, the selected team only. Choices the plan did not spell out were made while building and are marked **new**.
- **Related:** ADR 0010 (expo-sqlite, plain), ADR 0008, `.agents/rules/app-state.md` ("Offline upcoming shifts"), brief Requirement 2

## Problem

A person must see their upcoming shifts with no connection, with a visible "last updated" time, and after closing the app. The schedule screen asks for one week at a time and first needs who you are, which team and the team's time zone: none of that is saved, so at an offline start the app would know nothing. What is saved has to be able to stand on its own.

## Options considered

1. **Persist the existing "mine" week query** and show the phone's fetch time. No server change, but the answer has no time zone or team name (the times could not be shown in the team's clock), and one week is a poor "upcoming".
2. **A new route that answers everything the offline screen needs** (`GET /teams/:teamId/shifts/upcoming`: the caller's own unfinished shifts starting within 42 days, the team's name and time zone, and `asOf`, the server's clock). One request, one self-contained saved record, and a "last updated" that comes from the server. Chosen.
3. **Persist `['me']`, the teams and the team detail too.** Rejected: the rule is one allowlisted query, and those hold roles, member lists and billing notices.

## Decision

- **The route** is a team route (`shifts.view`, every role), strict Zod on params and query (the query is empty: the window is the server's, the person is the signed-in one, so `?userId=` is a 400). It returns **only the caller's own shifts, whatever the role**, so a Manager's saved copy never holds the team's schedule. The window is `now` to `now + the calendar's 42-day cap` (`SHIFTS_MAX_RANGE_DAYS`, approved 2026-10-26), a shift counted until it ends. Registered before `/:shiftId`.
- **The app saves one query**: `['upcoming-shifts', userId, teamId]` (any query that **holds data**, not only a successful one: a refresh that fails offline sets the status to `error` but keeps the data, and the first offline start on the emulator emptied the saved row when the filter said `success`; a test covers it), through TanStack's persister, into `expo-sqlite` (ADR 0010: plain, no SQLCipher, never the vec extension), one row in one table. **The parser keeps only** `id`, `title`, `area`, `startsAt`, `endsAt`, the team's name and time zone and `asOf`. The note, the break and the assignee are dropped before anything is cached.
- **Maximum age: 7 days, CHOSEN, NOT MEASURED.** A week-old "upcoming" list is already unreliable, and it bounds how long personal data stays on a lost or lent phone. Counted from when the phone fetched the data (`dataUpdatedAt`).
- **When it is shown (new):** only when the schedule cannot load because the phone is offline, or the server could not be reached or was not well (timeout, dropped connection, 5xx, 429). A server that **answered with a refusal** (401, 403, 404...) never gets an old copy. The view is read-only: nothing opens, nothing can be created, nothing is queued.
- **Whose it is.** The row records its user; that is the persister's buster. At an offline start the user is not yet known, so the row's own user is trusted (sign-out deletes the row, the tokens and the caches together). A signed-in session for anyone else deletes the row first. **new**
- **Sign-out** deletes it: the account epoch is bumped, the caches are cleared, then saving stops and the row is deleted (`PRAGMA secure_delete` and a checkpoint, so the file keeps no copy). A save that started before the account changed is discarded: saves and the clear run in one queue, so a save either finished before the clear or sees the new epoch and writes nothing.

## Why

- The saved record is self-contained and as small as the screen needs, which is what ADR 0010 promised ("only the allowlisted fields").
- `asOf` is the server's clock, so a phone with a wrong clock cannot show a wrong "last updated".

## Consequences

- **The library's `maxAge` is switched off (Infinity), and the age is checked on the data.** TanStack's own `maxAge` compares with the time of the last *save*, which moves every time the app opens: an old copy would never expire. The age is checked when the app starts (an old copy is deleted), when it is saved (an old query is not written) and where the screen reads it. The query's `gcTime` is the same 7 days, or a copy put back from the device would be dropped from memory after 5 minutes and the next save would forget it.
- **Not encrypted at the application level** (ADR 0010). The mitigations are the minimal fields, the maximum age, the buster, and deletion on every sign-out.
- **A saved copy can be wrong**: a manager may have changed a shift since. That is why "last updated" is always shown, and why the screen refetches whenever it can.
- **Only the selected team** is saved; a person in two teams sees the other team's shifts only online. Opening the other team once online saves it instead, and replaces nothing (one entry per team, both kept until their own age ends). **new**
- **Revisit when** the shifts become more sensitive (SQLCipher, ADR 0010), or when an offline write is wanted: that needs its own decision, because a delayed write would overwrite a newer change (`app-state.md`).

## Evidence

Two bugs were found by the emulator proof and fixed in this PR: queries paused offline for ever (ADR 0035), and a failed refresh emptying the saved row (above).

The server tests (own shifts only, the 42-day edge, other team 404, a person or a window in the query 400), the 16 app tests in `app/src/offline/offline.test.ts` (allowlist, restart, age that does not slide, another person, sign-out, a write in flight at sign-out, a failing store), and the emulator in airplane mode: see the PR.
