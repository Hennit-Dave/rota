# Rota

Rota is a shift-scheduling mobile app for small teams such as restaurants, clinics and shops.

Design: [Rota screens in Figma](https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY)

Status: in progress

## Run the server locally

Needs Node 24 (`nvm use` reads `.nvmrc`) and npm. The API and worker processes exist, along with the database
and queue foundation: Prisma, two Neon shards, shard routing, pooled per-shard clients, and the BullMQ
background job worker running on Aiven Valkey. Features come later.

```sh
cd server
npm ci
npm run db:generate    # generates the Prisma client into src/generated/ (gitignored, so a fresh clone has none)
npm run build
npm run typecheck
npm test              # runs unit tests (no database, no network)
npm run test:integration # runs database integration tests (needs .env, guards against non-test DB); also test:integration:slow and test:all, see below
npm run start:api      # terminal 1: http://localhost:3000/health returns {"ok":true}. Needs AUTH_JWT_SECRET, MAIL_FROM and MAIL_REPLY_TO (see below)
npm run start:worker   # terminal 2: logs "worker running". Needs RESEND_API_KEY (see "Invitations and email")
```

`db:generate` needs no `.env`, no database and no network: it reads only `prisma/schema.prisma`. The
`build`, `typecheck`, `test` and `dev:*` scripts run it first automatically, so it is safe to skip, but
`src/generated/` must exist before anything that imports the Prisma client compiles. Re-run it after any
schema change. The generated client is never committed.

### Database commands (need a root `.env`)

Copy `.env.example` to `.env` at the repo root and fill in the values. `.env` is gitignored. `PORT` is
optional and defaults to 3000. The API and worker start without the database values; the commands below
need them.

| Command | Needs | What it does |
|---|---|---|
| `npm run db:deploy:a` then `npm run db:deploy:b` | `SHARD_A_DIRECT_URL`, `SHARD_B_DIRECT_URL` | Applies migrations to shard A, then shard B. Run A first, check it, then B |
| `npm run db:status:a`, `npm run db:status:b` | the matching direct URL | Shows each shard's migration status |
| `npm run db:parity` | both direct URLs | Fails if the shards' applied migrations differ |
| `npm run db:check-pooled` | `SHARD_A_DATABASE_URL`, `SHARD_B_DATABASE_URL` | Checks both shards through the pooled `-pooler` URLs. A failure is reported, never retried on a direct URL |

Migrations use the direct (unpooled) URLs because Prisma's migration engine does not work through the pooler.
Runtime clients (`server/src/db/clients.ts`) use the pooled URLs. See `docs/decisions/0002-database-foundation.md`.

### Queue and worker commands (need `VALKEY_URL` in `.env`)

Valkey on Aiven is used for background queuing (`docs/ARCHITECTURE.md`, `docs/decisions/0003-queue-worker-and-recovery.md`).
The service must have `maxmemory-policy: noeviction`.

| Command | Needs | What it does |
|---|---|---|
| `npm run jobs:check-valkey` | `VALKEY_URL` | Connects to Valkey, verifies `noeviction` policy, reports status |
| `npm run jobs:prove:boxes-4-5` | `VALKEY_URL`, `SHARD_A_DATABASE_URL`, `SHARD_B_DATABASE_URL` | Proves Box 4 (immediate execution on Shards A & B with timing) and Box 5 (delayed fire strictly at/after run_at, exponential backoff) |
| `npm run jobs:prove:crash` | `VALKEY_URL`, `SHARD_A_DATABASE_URL` | Proves Box 6 (abrupt SIGKILL termination mid-claim and recovery upon lease expiry) |

### Invitations and email (server; needs `MAIL_FROM`, `MAIL_REPLY_TO` for the API and `RESEND_API_KEY` for the worker)

An Owner or Manager invites someone by email into a role. The API writes the invitation and its email work row together, and the **worker** sends the
email through Resend (never the request). Both processes refuse to start without their mail settings: `MAIL_FROM` (`Rota <notification@rota.davebuilds.design>`)
and `MAIL_REPLY_TO` (`rota@davebuilds.design`) for the API, and `RESEND_API_KEY` (a secret, worker only) for the worker. Names are in `.env.example`.
Optional: `INVITE_EXPIRY_DAYS` (7), `INVITE_GLOBAL_DAILY_CAP` (50 invite emails per UTC day: Resend's free plan sends 100 a day in total),
`INVITE_LINK_BASE_URL` (`https://rota.davebuilds.design`). Tests use a fake Resend and never send real mail. Decisions: `docs/decisions/0015-invitations.md`,
`docs/decisions/0016-email-sending-job.md`. The link only opens the app once `rota.davebuilds.design` is live on GitHub Pages and Android has verified it (issue #35, ADR 0019).

### Authentication (server only; needs `AUTH_JWT_SECRET`, `VALKEY_URL` and the shard URLs in `.env`)

Email-and-password sign-up with short-lived access tokens, rotating refresh tokens and logout. The API refuses to start
without a signing secret. Routes, error codes and limits: `docs/ARCHITECTURE.md` (section 5) and `docs/SECURITY.md`.

**Password reset and magic link** (slice 2b, ADR 0020): `POST /auth/password-reset/request` and `/submit`, `POST /auth/magic-link/request` and `/redeem`. A request is
answered the same for every address and emails a single-use link (a reset lasts 1 hour, a magic link 10 minutes) through the same email job as invitations, so the
**worker must be running** (`RESEND_API_KEY`) for the email to go out. The app opens the links at `/reset/<token>` and `/magic/<token>`. New table `auth_tokens`
(migration `20261026140000_add_auth_tokens`): run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/` before using a real shard.

**Shifts and the calendar** (slice C1, ADR 0021): `GET/POST /teams/:teamId/shifts` and `GET/PATCH/DELETE /teams/:teamId/shifts/:shiftId`. An Owner or Manager publishes, edits and deletes
shifts; everyone in the team can read them; one person cannot be booked twice at the same time (`409`). New tables `shifts` and `activity` (migration
`20261026160000_add_shifts_and_activity`): run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard.
Optional: `SHIFTS_MAX_RANGE_DAYS` (42). The app's home is now the Schedule, with a bottom bar (Schedule, Team, Settings).

**Activity feed** (slice C2, ADR 0022): `GET /teams/:teamId/activity?limit&cursor` returns what happened to the team's shifts, newest first, a page at a time by cursor (20 rows by default, 50 at most), limited to 120 requests a minute per user, and answering `503` when Valkey is down. New migration `20261027120000_add_activity_feed_index`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `ACTIVITY_PAGE_DEFAULT`, `ACTIVITY_PAGE_MAX`, `RATE_LIMIT_FEED_USER_MAX` / `_WINDOW_SECONDS`. `npm run db:feed-proof -- seed | explain | clean` (test shards only) seeds 10,000 feed rows and prints the query plan. In the app, "View activity" on the Schedule opens it.

**Shift swaps** (slice S1, ADR 0023): `GET/POST /teams/:teamId/swaps` and `/:swapId`, `/:swapId/cancel`, `/:swapId/approve`, `/:swapId/reject`. Staff ask to exchange one of their upcoming shifts for a teammate's; an Owner or Manager approves or rejects (never someone who is part of the swap, unless they are the Owner and the only approver). A retried request (same `Idempotency-Key`) never creates a second one; at most 3 requests wait per person and 10 may be made per hour. Two new migrations, `20261028100000_add_swap_activity_kinds` and `20261028110000_add_swap_requests`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `SWAPS_MAX_PENDING`, `RATE_LIMIT_SWAP_REQUEST_USER_MAX` / `_WINDOW_SECONDS`. In the app: the Swaps tab.

**Invite links** (issue #37, ADR 0025): `POST /teams/:teamId/invitations/links` makes a single-use link, not tied to an email address, that an Owner or Manager can share (Staff only, 48 hours, at most 10 pending per team); the same `DELETE` revokes it, and the existing preview and accept routes use it. One migration, `20261028170000_add_invitation_links`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `INVITE_LINK_EXPIRY_HOURS`, `INVITE_LINK_MAX_PENDING`, `RATE_LIMIT_INVITE_LINK_USER_MAX` / `_WINDOW_SECONDS`, `RATE_LIMIT_INVITE_LINK_TEAM_MAX` / `_WINDOW_SECONDS`. In the app: "Create an invite link" on the invite form (Copy or Share), and link rows in the pending list.

**Settings** (slice S2, ADR 0024): `GET` and `PATCH /settings`. The server is the single source of truth for quiet hours, time zone, notification types (shift changes, swap updates, billing), language (`en` only) and theme; each setting has its own server-set `updatedAt` and the most recent change wins (the weakness is in `docs/STATE.md`). One migration, `20261028150000_add_user_settings`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Optional: `RATE_LIMIT_SETTINGS_READ_USER_MAX` / `_WINDOW_SECONDS`, `RATE_LIMIT_SETTINGS_WRITE_USER_MAX` / `_WINDOW_SECONDS`. In the app: the Settings tab (the sign-out buttons are under "Account & sessions"), and the theme setting now colours every signed-in screen. Quiet hours are stored but not yet enforced: that arrives with push notifications.

**Billing engine and schema** (slices P1 + P2, ADR 0026): no endpoint yet. `server/src/billing/` is the pure proration engine (integer cents, the brief's example is 2000; a charge under Stripe's 50-cent minimum is applied free) and the ledger functions; one migration, `20261028190000_add_billing`: run `npm run db:deploy:a` and `npm run db:deploy:b` from `server/`, then `npm run db:parity`, before using a real shard. Unit tests: `npm test`; schema tests against the TEST shards: `node --env-file-if-exists=../.env --import tsx --test --test-concurrency=1 src/billing/billing-schema.integration.test.ts`. This integration uses Stripe test mode only. Live-payment eligibility has not been verified. Stripe itself arrives with the next slice.

```sh
openssl rand -base64 32   # copy the output into AUTH_JWT_SECRET in the root .env (at least 32 bytes once decoded)
cd server && npm run build && npm run start:api
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests only: no database, no network |
| `npm run test:integration` | Needs the `TEST_*` variables in `.env`. Runs against the **test** shards and real Valkey, one file at a time. The fast integration tests. `valkey-recovery.integration.test.ts` starts its **own disposable local Valkey** (never the shared one) and needs `valkey-server` on PATH, or `LOCAL_VALKEY_BIN` pointing at it (Homebrew: `/opt/homebrew/opt/valkey/bin/valkey-server`); without it the tests skip with a message |
| `npm run test:integration:slow` | The concurrency and revocation-race tests (`*.slow.test.ts`). They hold database locks on purpose and take minutes against Neon |
| `npm run test:all` | All three. **Run it before every PR** |
| `node --test site/site.test.mjs` (from the repo root) | Checks the link host files in `site/` (ADR 0019): `assetlinks.json` is present and matches the app, the pages stay static. The Pages workflow runs it before every deploy |

Try it (default port 3000). This writes to the database in `SHARD_A_DATABASE_URL`, which is the real shard A, so use an address you are happy to leave there:

```sh
curl -s -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada Example","email":"ada@example.com","password":"a-long-enough-passphrase"}'
# -> 201 { user, session: { accessToken, accessTokenExpiresAt, refreshToken } }
curl -s localhost:3000/auth/me -H "authorization: Bearer $ACCESS_TOKEN"
curl -s -X POST localhost:3000/auth/refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
curl -s -X POST localhost:3000/auth/logout -H "authorization: Bearer $ACCESS_TOKEN"
```

## Run the app (Android, development build)

Expo SDK 58, React Native 0.88, Android only. Remote push does not work in Expo Go, so the app runs as a **development build**
(a debug app that loads its JavaScript from your computer). Decisions and the 16 KB page-size audit: `docs/decisions/0011-*.md`.
Where each piece of data lives: `docs/STATE.md`.

```sh
cd app
npm ci
npm run typecheck
npm test                 # unit tests, no device (client, refresh, sign-out, config, EXPO_PUBLIC allowlist)
npx expo-doctor          # 20 checks, should all pass
```

**Local build on an emulator or phone (free, does not use an EAS build).** Needs an Android SDK (`ANDROID_HOME`, usually
`~/Library/Android/sdk`) and a JDK. Android Studio's bundled JDK (25 on 2026-10-21) built it with Gradle 9.4.1; EAS itself uses JDK 17.
The first build downloads Gradle and NDK 27.1.12297006, so allow time and about 3 GB.

```sh
cd app
echo 'EXPO_PUBLIC_API_URL=http://10.0.2.2:3100' > .env      # 10.0.2.2 = this computer, seen from the emulator
npx expo prebuild --platform android --no-install            # generates android/ (gitignored)
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=$HOME/Library/Android/sdk
cd android && ./gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a && ./gradlew --stop && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
npm start                                                    # Metro; then open the app (or: adb shell am start -d "exp+rota://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" design.davebuilds.rota)
```

Run the API on a free port in another terminal (`PORT=3100 npm run dev:api` in `server/`; the server's default 3000 may be taken by another
project). The first screen is the sign-in screen. After signing in, the Schedule opens; the development-only link to the API check is under Settings, then Account & sessions
(`/dev-api`: it calls `GET /health` and says "The API answered: ok."), and from there a link to a check of every native module
(`rota://dev-check`, also reachable directly by that link, signed in or not).

**Open an invite link on the emulator** (until `rota.davebuilds.design` is live and verified, issue #35, a tapped `https` link opens the browser, so the app is targeted directly; `-p` skips link verification):
`adb shell am start -W -a android.intent.action.VIEW -d "rota://invite/<teamId>.<secret>" -p design.davebuilds.rota` (or the `https://rota.davebuilds.design/invite/...` form). Opening it consumes nothing; only the Accept button does. The link is in the invite email, or, for a proof with the worker off, in the email work row's payload on the **test** shards. Never paste a link into a PR or a log.

**Android 17 and the local API.** A development build declares `ACCESS_LOCAL_NETWORK` (dev-client server discovery), and on Android 17 an
address such as `10.0.2.2` counts as the local network. If the "nearby devices" prompt was declined, requests to the local API hang with no
error. Allow it, or run `adb shell pm grant design.davebuilds.rota android.permission.ACCESS_LOCAL_NETWORK`. A release build does not declare it.

**Check 16 KB page-size support** (the emulator image is Android 17 with 16 KB pages; `adb shell getconf PAGE_SIZE` must print 16384):

```sh
python3 scripts/check-16kb.py android/app/build/outputs/apk/debug/app-debug.apk    # zipalign -c -P 16, then every 64-bit .so; ends "RESULT: PASS"
```

Run it on the EAS build's APK too, before installing it. It fails (exit 1) on any library that is not 16 KB aligned.

Push needs `app/google-services.json` (Firebase client config, gitignored; ask Dave for it, or download it from the Firebase console for the
Android app `design.davebuilds.rota`). EAS cloud builds get it from the EAS file variable `GOOGLE_SERVICES_JSON`. Without it the app builds and runs but cannot
register for push. See ADR 0011. Nothing else needs a secret: the only `EXPO_PUBLIC_` variable is the API address (`docs/SECURITY.md`).

## Commands

### Look at the Swaps tab on the emulator (test shards, local Valkey)

Needs a root `.env` with the `TEST_SHARD_*` URLs and `TEST_DATABASE_ALLOWED=true`, an installed development build (see above), and a running emulator.
Use one terminal for each of the first three steps. Nothing here touches a real shard or the shared Aiven Valkey.

```sh
# 1. A disposable local Valkey (the binary is not on PATH; see "Run the server locally")
mkdir -p /tmp/rota-valkey && cd /tmp/rota-valkey
/opt/homebrew/opt/valkey/bin/valkey-server --port 6392 --bind 127.0.0.1 --save "" --maxmemory-policy noeviction

# 2. The API, pointed at the TEST shards, on port 3100
cd server && npm run build
set -a; . ../.env; set +a
PORT=3100 VALKEY_URL=redis://127.0.0.1:6392 \
  SHARD_A_DATABASE_URL="$TEST_SHARD_A_DATABASE_URL" SHARD_A_DIRECT_URL="$TEST_SHARD_A_DIRECT_URL" \
  SHARD_B_DATABASE_URL="$TEST_SHARD_B_DATABASE_URL" SHARD_B_DIRECT_URL="$TEST_SHARD_B_DIRECT_URL" \
  node dist/api/main.js                      # http://127.0.0.1:3100/health returns {"ok":true}

# 3. Metro, in watch mode (CI mode does not serve edits)
cd app
EXPO_PUBLIC_API_URL=http://10.0.2.2:3100 npx expo start --dev-client --port 8081 --clear
```

```sh
# 4. Seed "The Olive Room": a manager, two staff and one pending swap. Prints the manager's email and password.
cd server
VALKEY_URL=redis://127.0.0.1:6392 npm run db:demo-swap

# 5. Open the app on the emulator, sign in with the printed email and password, then tap Swaps
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d "exp+rota://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" design.davebuilds.rota
```

Notes:
- Each seed run adds a new team and four users to the **test** shards (it never deletes them: `app.stop()` would delete the team). Remove them by hand when you no longer need them.
- If the app is already signed in as someone else, use Settings, then Account & sessions, then Log out first.
- When typing with `adb shell input text`, tap the field first and check it has focus. With no field focused, a double `r` in the text reloads the app (React Native's dev shortcut) and the rest of the text is lost.
- To use the API from the host instead of the emulator, replace `10.0.2.2` with `127.0.0.1`.
