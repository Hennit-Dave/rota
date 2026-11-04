# 0039: Sentry on the server and in the app: errors only, one redaction list, one gate

- **Status:** accepted (2026-11-04)
- **Date:** 2026-11-04
- **Decided by:** Dave
- **Related:** `.agents/rules/observability.md` (Sentry), `docs/SECURITY.md` (the DSN row, the breadcrumb rules), ADR 0011 (the native build that already holds Sentry), ADR 0038 (the cache, whose failures are also logged), issue #41

## Problem

The brief asks for Sentry on the app and the server, with errors that can be tied to a request, a user and a team, and without leaking secrets. The Developer plan has a small
quota. The code already ships `@sentry/react-native` in the development build (ADR 0011) but nothing was initialised.

## Setup Dave made (2026-11-04)

Organisation `davebuilds`, EU data storage; projects `rota-server` (Express) and `rota-app` (React Native); error monitoring only. Organisation-level settings, which apply to both
projects: Require Data Scrubber, Require Default Scrubbers and Prevent Storing of IP Addresses are on; Allow Shared Issues is off; Enhanced Privacy is on; Join Requests are off.
The DSNs are in the root `.env` (`SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_DSN`); the app reads its own from `app/.env` (Expo only reads the app's `.env`), which is gitignored.

## What Sentry's own pages say about the Developer plan (read 2026-11-04)

From `sentry.io/pricing`: **5k errors**, one user, unlimited projects, **30-day lookback** (retention). Tracing, logs, metrics and replays have their own quotas on the plan; **we send none of them**.
`docs.sentry.io/pricing/quotas`: events over the quota "will not be accepted". After the 14-day Business trial an organisation without a paid plan is "automatically assigned a free
Developer plan". **Not stated by those pages, so not assumed:** whether the 5k is *per month* for Developer (the docs say paid plans have monthly presets and "the free Developer plan has
similar presets"), whether Developer signup needs a card, and overage billing on Developer. **The "per month" reading is UNCONFIRMED.** The Usage page shows only the trial period (4 to 17
November); Dave will check the first Developer period after the trial ends. Until then everything below treats 5,000 as a monthly budget.

## Options considered

1. **The SDK's defaults, with Sentry's server-side data scrubbing as the only protection.** Rejected: version 11 of `@sentry/node` collects user identity, cookies, headers, request and response bodies,
   query strings and the values of local variables by default. Server-side scrubbing is a second layer (Dave turned it on), not the first.
2. **Sentry's Express integration, capturing every error that passes through Express.** Rejected: it would also send errors we answer deliberately (a 503 while the database wakes), it attaches request data,
   and it would double-report with our own error handler.
3. **Capture explicitly, in the places that know what is a bug; strip everything with one shared list; limit what leaves with a gate** (chosen).

## Decision

**What is captured.**
- **API:** the error handler's `unhandled_error` branch (anything that is not an `ApiError`, a malformed body or a transaction that could not start), plus a database that cannot be reached (answered with the
  polite 503 as before, and reported too, which the gate limits to one per 5 minutes). Process crashes (uncaught exceptions and unhandled rejections) come from the SDK's own handlers.
- **Worker:** a job that has failed **for good** (it said stop with `TerminalJobError`, or used its last attempt), through a new `onTerminalFailure` hook in `jobs/worker.ts` that cannot change what a job does,
  and process crashes. A retryable failure is not reported.
- **App:** a root `ErrorBoundary` (render errors), the SDK's global handlers (uncaught errors and unhandled rejections), and TanStack Query's `onError`, filtered by `isReportableError`: **not** reported are offline,
  a lost connection, a signed-out device, a session the server ended, an aborted request, any answer below 500 and 503; **reported** are a server error with its request ID, a bad configuration and any other thrown error.

**What is sent, and what is not.**
- **Errors only.** No tracing sample rate is set; no code calls a log or metric API and `beforeSendLog` and `beforeSendMetric` drop anything that did; no replay, feedback or profiling is configured; screenshots and
  the view hierarchy are off. Server breadcrumbs are off (`maxBreadcrumbs: 0`).
- **Everything the SDK collects by default is switched off** on the server (`dataCollection`: user, cookies, headers, bodies, query strings, database query data, queue arguments, local-variable values), and
  `sendDefaultPii` is off in the app (the app's options type does not accept `dataCollection`; the user is only an ID and `scrubEvent` removes any request, cookie, header, body or query string).
- **Tags** are put on at the moment of capture, from the failing request's own data, never onto a shared scope: `request_id`, `team_id` (only if the path's team ID passed validation), `route` (the template, never the raw
  URL), `role` (`api`, `worker`), and for a job `job_kind`, `row_id`, `attempts`, `terminal`, with the work row's origin request ID as `request_id`. **User: the ID only.** In the app the user is set when someone signs in and
  cleared whenever the session store says nobody is signed in (every sign-out path resets it); the team tag follows the selected team.
- **Source maps:** the server runs with `node --enable-source-maps`, so stack traces name the TypeScript file and line without uploading anything. The app's source-map upload needs an auth token and waits for the deploy slice.

**One redaction list for both** (`observability.md`: "one redaction list serves the logger and Sentry"). `shared/sentry-scrub.ts` is plain TypeScript with no imports, copied **byte for byte** to
`server/src/observability/sentryScrub.ts` and `app/src/observability/sentryScrub.ts` by `node shared/sync-sentry-scrub.mjs`; a test in each package fails if its copy differs. It replaces the value under any key whose name
suggests a secret, a person or a payment (Authorization, cookies, passwords, tokens, secrets, API keys, signatures, JWTs, emails, card number, brand, last four, expiry, payment method and intent, amounts), and any string that looks like one: bearer and basic
credentials, JWTs, invite tokens, magic and reset links, secrets in a query string, passwords in a URL, Stripe keys, webhook secrets, client secrets and object ids, Resend keys, email addresses and card numbers (Luhn-checked).
A URL loses its query string and fragment. The user is cut to an ID, the request is removed, stack-frame variables and source lines are removed, breadcrumbs lose their console lines.

**The gate on what leaves** (CHOSEN, NOT MEASURED; Dave, 2026-11-04): one event per error (same type, place and wording, with ids and numbers ignored) per 5 minutes; at most 10 events a minute; **50 a day per server process**
(API and worker each); **20 per app session**. A duplicate is turned away before it uses any budget. The server's three numbers are config (`SENTRY_MAX_EVENTS_PER_DAY`, `SENTRY_MAX_EVENTS_PER_MINUTE`, `SENTRY_DEDUPE_SECONDS`).
The arithmetic behind them: 5,000 over 30 days is about 166 a day, shared by the API, the worker and the app; 100 a day from the two server processes leaves the app about 66.

**k6.** `X-Load-Test: k6` is honoured **only while `LOAD_TEST_MODE=true`**, which is set for the k6 run and at no other time. A client can send any header, so honouring it by default would let anyone hide their errors from
monitoring. With the switch off the header is ignored; a test proves it (`sentry.unit.test.ts`), and the error handler only passes the header along, so the decision is in one place. The k6 script must send the header.

**The DSN is public by design,** which is why `EXPO_PUBLIC_SENTRY_DSN` is allowed: checked against Sentry's own page (see `SECURITY.md`): "DSNs are safe to keep public because they only allow submission of new events and related event
data; they do not allow read access to any information." **The residual risk, stated on that page:** anyone with the app can send fake events at the shared quota; the controls are IP blocking and rotating the key. The app's own limit
does not bind someone who is not using the app. The auth token (source maps) is never public and is not created until the deploy slice.

## Native build: none

The installed development build already contains Sentry's native libraries (`libsentry.so` and `libsentry-android.so` in the APK on the emulator, ADR 0011). `Sentry.init` is JavaScript. **Sentry's docs do not say whether a JS-only
init needs a rebuild, so this was proved, not assumed:** on the emulator, in the existing dev build with no rebuild, the app bundled and launched with Sentry in it, the dev-check screen reports `client=set, sending to <the EU host>`,
`captureException` returned an event id and `flush` returned true. `@sentry/react-native` stays at **8.28.0** (npm has 8.33.0): bumping it would put a newer JS layer over the older native one, so it waits for the next native build
(issue #41). The config plugin's `organization`, `project` and `url`, and the auth token, only matter when a release build uploads source maps: the preview build in the deploy slice. For an EU organisation that upload URL is probably not
`sentry.io`; that is confirmed with the first upload.

## Measured

- **Memory:** the idle API uses 146.9 MB with Sentry off and 165.0 MB with it on (mean of 3 samples each): **about 18 MB more**, against a 512 MB budget. (Version 11 brings OpenTelemetry's API with it; no native addon.)
- **A real crash:** an uncaught exception in a process with the reporter on produced one event (`mechanism: onuncaughtexception`, not handled), its message arrived as `process crash for [redacted] with [redacted]`, no user and no request were attached, and the process exited 1.

## Consequences and limits

- **The gate's state is in memory.** A process that crashes and restarts in a loop starts each run with a full budget, so a crash loop can send more than 50 a day. The Developer quota is the backstop (events over it are not accepted).
- A process crash event has no request or team tags (there was no request). A request-time error has them.
- An app on a device Dave does not control, or someone holding the DSN, can use the shared quota: see the DSN row in `SECURITY.md`.
- The app has no source-map upload until the deploy slice, so a release build's stacks are minified until then; development builds are readable.
- A bad `SENTRY_DSN` stops the API and the worker at start (a typo at deploy time should be seen at once); no DSN means off.
- Sentry's retention on this plan is the **30-day lookback** (`observability.md` asks for retention to be recorded). The host's own log retention is recorded in the deploy slice.
- **Revisit** when the plan changes, when the first Developer period shows how the 5k is counted, or when the k6 report shows the gate dropping events that mattered.

## What changes in production

With several API instances each would keep its own gate, so the daily cap would multiply by the number of processes; a shared (Valkey) gate, or a lower per-process number, would replace it. A real deployment would also upload source maps for both packages and tag a release.

## Evidence

- `shared/sentry-scrub.ts` through the server's copy (`sentryScrub.unit.test.ts`, 37 tests): 18 kinds of secret removed, ordinary identifiers kept, edge cases of random tokens (a secret that starts or ends with `-` or `_`), keys, URLs, breadcrumbs, a whole
  event (none of 13 secrets survive in the serialized event; the input is not changed), the fingerprint, and the gate. **The random-data tests were run 100 times with fresh secrets**, which found and fixed two real gaps (a Stripe-style
  key containing `_` or `-`, and an invite token ending in `-`); the deterministic edge-case test now pins both.
- `sentry.unit.test.ts` (13): tags, user and secrets on a captured event; only errors are sent (no log, metric or breadcrumb leaves); **two requests failing at once keep their own request and team IDs**; the gate (duplicates, 10 a minute,
  the daily cap); **`X-Load-Test` is ignored while `LOAD_TEST_MODE` is off** and honoured while it is on; with no DSN nothing is sent. `errorReporting.unit.test.ts` (8): what the API's handler reports and what it does not.
  `worker.integration.test.ts`: a job that says stop and a job on its last attempt are reported once each, a retryable failure and a success are not, and a hook that throws changes nothing.
- App (`observability.test.ts`, 10, in `npm test`, 416 pass): the copy is identical to the shared file; which errors are reportable; a navigation breadcrumb to an invite, magic or reset link loses its token and query string.
- **Test events, visible in Sentry (Dave checks them):** from the server, event `a873dbd9cc0747e0a59f4639902245e2`, `request_id` `d6991505-b111-4720-a578-0bf488ce7457`; from the app on the emulator, event
  `017c3ecc3f24400b85af893fc3205032`, `request_id` `6a487902-00d9-4254-8fa2-eae449d7438b`. Each carries FAKE secrets (an email, a card number, a bearer token, an invite link) that should show as `[redacted]`. Screenshots and logs:
  `Rota-evidence/sentry/`.
