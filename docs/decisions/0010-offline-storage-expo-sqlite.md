# 0010: Offline storage for shifts: expo-sqlite, plain

- **Status:** accepted (2026-10-21)
- **Date:** 2026-10-21
- **Decided by:** Dave
- **Related:** issue #9, `.agents/rules/app-state.md` ("Offline upcoming shifts"), `.agents/rules/expo-builds.md`

## Problem

Upcoming shifts must be viewable offline, with a visible "last updated" time, and survive closing the app (brief,
Requirement 2). Shift data is personal information. The storage library has a native module, so it must be in the first build.

## Options considered

1. **AsyncStorage (`@react-native-async-storage/async-storage` 2.2.0):** simplest, with an official TanStack persister. Unencrypted, and
   the brief's self-study topic is precisely why it is unsafe for tokens. Using it for shift data would work but invites the
   question of why the project has it at all.
2. **expo-sqlite (~58.0.13):** Expo's own module, version-matched to the SDK, stores rows in a database file in the app's private
   storage. Needs a small custom persister (a key/value table).
3. **react-native-mmkv 4.3.2:** very fast, supports an encryption key, but needs a second native package
   (`react-native-nitro-modules`) and neither is managed by `expo install`.

## Decision

**expo-sqlite, plain: no SQLCipher.** The plugin is configured `useSQLCipher: false` and `withSQLiteVecExtension: false`.

## Why

- First-party and version-matched, so one fewer moving part than option 3, and no AsyncStorage in the project.
- The data is small and low-sensitivity by design: only the allowlisted fields needed to show upcoming shifts, never tokens,
  billing data or other queries (`app-state.md`).

## Storage protection (what is and is not true)

- The database file sits in the app's private sandbox, unreadable by other apps.
- Android encrypts the device's storage (file-based encryption), so the file is encrypted at rest while the device is locked.
- **It is not encrypted at the application level.** Someone with the unlocked device and root access, or a backup that includes
  the file, could read it. The mitigations are minimisation (allowlisted fields only), a maximum cache age, a buster that includes
  the user ID so another account never sees it, and **deletion on every logout and forced sign-out**.
- Tokens are not here: they live in `expo-secure-store` only.

## Consequences

- **Never enable `withSQLiteVecExtension`.** The sqlite-vec extension ships a prebuilt `vec.so` that is aligned for 4 KB pages, not
  16 KB (measured in the installed package). It is only packaged when that option is on, and the config sets it to false.
- **Turning on SQLCipher later is a native rebuild** (and needs a key kept in secure-store). Decided against for now.
- The persister, the allowlist, the maximum age (config, recorded in `STATE.md`) and the "last updated" display are built in the
  offline-shifts slice. This PR installs the module and proves it loads.
- **Revisit when:** the threat model changes (for example persisted data becomes more sensitive), at which point SQLCipher or app-level
  encryption is reconsidered.

## Evidence

The development-only check screen opens an in-memory database on the emulator and reports the SQLite version, that SQLCipher is
absent and that `vec_version()` fails (the extension is not loaded). See ADR 0011, Evidence.
