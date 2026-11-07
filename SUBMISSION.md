# Submission

Maps every requirement in `docs/requirements/ROTA-BUILD-PROMPT.md` (the build prompt; the original brief,
`/Users/blk/Downloads/final-graduation-task (1).pdf`, wins if they ever disagree) to where it is proven:
a PR, an ADR, a test file, or a doc section. Written 2026-11-06 from what is actually in the repo — nothing
here is ticked without a link behind it. **Pending** means not yet proven; it is not ticked.

## Deliverables checklist (brief's own list — "a missing or broken link means the item is not complete")

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | Public GitHub repo | ✅ | [Hennit-Dave/rota](https://github.com/Hennit-Dave/rota) — public, description and topic tags set |
| 2 | **Android development build download link** | ✅ | [EAS build page](https://expo.dev/accounts/hennitdave/projects/rota/builds/a7d7a16c-6699-493a-b139-c7ce640d1c9f) (public, no sign-in, Install button), linked from [README.md](README.md). Passed full device testing on 2026-11-06 — real Tecno Pop 20 (Staff) + emulator (Owner) against the deployed API: sign-in both accounts, push delivered and opened to the right screen from a cold start, invite link opened to the right screen from a cold start (App Links verified on the real device), instant theme repaint (ADR 0024), issue #41's package bump shipped with no issues |
| 3 | **Deployed backend** | ✅ | `https://api.rota.davebuilds.design` on Northflank ([ADR 0040](docs/decisions/0040-northflank-deployment.md)); all 5 deployment-gate checks proven, [PR #77](https://github.com/Hennit-Dave/rota/pull/77) |
| 4 | `README.md` | ✅ | This repo's [README.md](README.md). First-screen order per the brief: one-liner, then GIF (embedded)/APK (linked, tested)/demo video (linked), live API, Stripe wording, stack, doc links. "Further down" sections all present: the problem it solves, tech stack and why, how to run it locally, architecture summary, key decisions, what I'd do next, and the Apple/Google in-app-purchase section |
| 5 | `ARCHITECTURE.md` | ✅ | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), including the diagram (row 10) |
| 6 | `STATE.md` | ✅ | [docs/STATE.md](docs/STATE.md) |
| 7 | `SECURITY.md` (8 threats) | ✅ | [docs/SECURITY.md](docs/SECURITY.md) — all 8, each with mitigation and proving tests |
| 8 | `SHARDING.md` | ✅ | [docs/SHARDING.md](docs/SHARDING.md) |
| 9 | `LEARNING-LOG.md` | ✅ | [LEARNING-LOG.md](LEARNING-LOG.md) — all 7 self-study topics ticked |
| 10 | **Architecture diagram** (Excalidraw or Mermaid) | ✅ | Mermaid, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#architecture-diagram) |
| 11 | **Test results for permissions, team isolation and proration** | ✅ | Permissions/isolation: `server/src/teams/permissions.unit.test.ts`, `server/src/teams/team-security.integration.test.ts`, `server/src/shifts/shifts.integration.test.ts`. Proration: `server/src/billing/proration.unit.test.ts` (24 cases, the brief's numbered 8 among them) |
| 12 | **Load test report** (200 VUs, before/after caching) | ✅ | [load-tests/REPORT.md](load-tests/REPORT.md), [PR #81](https://github.com/Hennit-Dave/rota/pull/81). `data.md` test 11's two halves: connections-stayed-within-limits is now proven (Neon Monitoring, both shards: 1-2 actual Postgres server connections for all 200 VUs, against a configured ceiling of 8 per shard primary — 5 API + 3 worker — and 5 per shard replica; 0.00s pooler wait), but the app-side Prisma pool-wait/database-time split still isn't measured. Tracked as [issue #83](https://github.com/Hennit-Dave/rota/issues/83) |
| 13 | **Demo video** (under 3 minutes, product first) | ✅ | [LinkedIn post](https://lnkd.in/p/dn2k73bD) (2:51), linked from [README.md](README.md) |
| 14 | **A LinkedIn post about one technical decision** | ✅ | Same [LinkedIn post](https://lnkd.in/p/dn2k73bD) — the Northflank incident and deploy-credential rotation |
| 15 | Before-and-after recordings of problems fixed | ✅ (ongoing) | Process has been followed since it was corrected (see `LEARNING-LOG.md`, 2026-10-22). Clips are held by Dave, not in the repo. [Issue #52](https://github.com/Hennit-Dave/rota/issues/52) (keyboard reappears on resume) is the most recent example: before frames at the time it was found, after recording attached to the closing comment, 2026-11-06, release build |
| 16 | Written self-study notes, every self-study topic | ✅ | [LEARNING-LOG.md](LEARNING-LOG.md) — EAS Build, AsyncStorage, refresh rotation/reuse, idempotency, observability, load testing, ADRs: all 7 entries, all ticked |
| 17 | GitHub description and topic tags | ✅ | Set on the repo (checked live via `gh repo view`) |
| 18 | Rota pinned on GitHub profile | ❓ Unknown | Not verifiable from the repo. Ask Dave |
| 19 | Git history scanned for secrets, anything found rotated | ✅ | Full history scanned with `gitleaks git --log-opts="--all"` (2026-11-06; 76 commits, all refs): 25 findings, all 25 verified as test fixtures (Stripe test/live key-shaped strings in `stripeConfig.unit.test.ts` and `cardGateway.unit.test.ts` testing the loader's own live-key rejection; a redaction-test fixture in `observability.test.ts`; fixed, documented "throwaway test values" demo passwords in `demo-swap.ts` and `push/proof-seed.ts`, test-shard only; fake invite-link tokens in 3 app test files; a fake password in `http.unit.test.ts` testing log redaction) — **zero real secrets found, nothing to rotate**. Separately, real deploy credentials were rotated as a precaution after the Northflank incident and for the k6 run, not because the scan found them (`docs/decisions/0040-northflank-deployment.md`) |

## Positioning section (brief)

| Item | Status | Evidence |
|---|---|---|
| Two LinkedIn posts/week during the build | ❓ Unknown | Not verifiable from the repo. Ask Dave |
| Portfolio case study (problem, constraints, architecture, 3 hardest decisions, results with load-test numbers, what's next) | ⏳ Pending | Not started. `load-tests/REPORT.md`'s numbers are ready to cite once written |
| 30 target companies in a lead tracker | ❓ Unknown | Not verifiable from the repo. Ask Dave |
| Outreach that leads with Rota, mapped feature-to-company-type | ✅ (map exists) | [docs/outreach-feature-map.md](docs/outreach-feature-map.md), kept current slice by slice |
| One CV/LinkedIn bullet with specifics | ⏳ Pending | Not written |

## Eight required features

| # | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Sign-up, login, logout, invite by email or link | ✅ | [ADR 0005](docs/decisions/0005-authentication-tokens-and-sessions.md), [ADR 0015](docs/decisions/0015-invitations.md), [ADR 0025](docs/decisions/0025-invite-links.md); [PR #21](https://github.com/Hennit-Dave/rota/pull/21), [#36](https://github.com/Hennit-Dave/rota/pull/36), [#40](https://github.com/Hennit-Dave/rota/pull/40), [#54](https://github.com/Hennit-Dave/rota/pull/54) |
| 2 | Role-based permissions | ✅ | [ADR 0014](docs/decisions/0014-teams-roles-and-permission-module.md); [PR #34](https://github.com/Hennit-Dave/rota/pull/34); `server/src/teams/permissions.ts` + `permissions.unit.test.ts` |
| 3 | Shift calendar + paginated activity feed | ✅ | [ADR 0021](docs/decisions/0021-shifts-calendar-and-activity-rows.md), [ADR 0022](docs/decisions/0022-activity-feed-cursor-index-and-fail-closed.md); [PR #47](https://github.com/Hennit-Dave/rota/pull/47), [#49](https://github.com/Hennit-Dave/rota/pull/49) |
| 4 | Shift swaps with manager approval | ✅ | [ADR 0023](docs/decisions/0023-swaps-with-manager-approval.md); [PR #50](https://github.com/Hennit-Dave/rota/pull/50) |
| 5 | Seat-based subscriptions, upgrades/downgrades, proration | ✅ | [ADR 0026](docs/decisions/0026-billing-engine-and-schema.md)-[0031](docs/decisions/0031-renewals-and-failed-renewals.md); [PR #56](https://github.com/Hennit-Dave/rota/pull/56)-[#61](https://github.com/Hennit-Dave/rota/pull/61) |
| 6 | Push notifications | ✅ | [ADR 0032](docs/decisions/0032-push-notifications-part-1.md), [ADR 0033](docs/decisions/0033-push-notifications-part-2.md); [PR #63](https://github.com/Hennit-Dave/rota/pull/63), [#65](https://github.com/Hennit-Dave/rota/pull/65). Cold start now verified too, 2026-11-06, real device (ADR 0032) |
| 7 | Settings synced across devices | ✅ | [ADR 0024](docs/decisions/0024-settings-server-source-of-truth.md); [PR #51](https://github.com/Hennit-Dave/rota/pull/51) |
| 8 | Offline viewing of upcoming shifts | ✅ | [ADR 0034](docs/decisions/0034-offline-upcoming-shifts.md); [PR #66](https://github.com/Hennit-Dave/rota/pull/66) |

## The backend system design standard

| Topic | Status | Evidence |
|---|---|---|
| Connection pooling, size justified | ✅ | `.agents/rules/data.md` ("Prisma clients and pools"): API 5 per shard primary + 5 per replica (20 total), worker 3 per shard primary (6 total), justified as "a starting proposal" pending the k6 report's measurements |
| Replication + read-your-own-writes | ✅ | [ADR 0037](docs/decisions/0037-read-replicas-and-read-routing.md); [PR #69](https://github.com/Hennit-Dave/rota/pull/69); `server/src/db/readRouting.integration.test.ts` |
| Sharding (two databases, hash of `team_id`) | ✅ | [docs/SHARDING.md](docs/SHARDING.md), [ADR 0002](docs/decisions/0002-database-foundation.md) |
| Caching (rosters, calendars; TTL + invalidation) | ✅ | [ADR 0038](docs/decisions/0038-team-cache.md); [PR #70](https://github.com/Hennit-Dave/rota/pull/70) |
| Rate limiting (Redis/Valkey, not in-memory) | ✅ | [ADR 0007](docs/decisions/0007-rate-limiting.md); `docs/SECURITY.md` ("Rate limiting") |
| Background jobs (retry, backoff, failed list) | ✅ | [ADR 0003](docs/decisions/0003-queue-worker-and-recovery.md), [ADR 0004](docs/decisions/0004-reconciliation-sweep.md) |
| Idempotency [self-study] | ✅ | Payments: `payment_requests` table, `Idempotency-Key` header, every payment and change route. Webhooks: `stripe_events`, unique by event ID. `LEARNING-LOG.md` 2026-10-21 |
| Observability [self-study] | ✅ | Request ID + structured logging: `docs/SECURITY.md` ("Request IDs and logging"). Sentry: [ADR 0039](docs/decisions/0039-sentry.md). `LEARNING-LOG.md` 2026-10-21, 2026-11-04 |
| Load testing [self-study] | ✅ (with the gap noted above) | [load-tests/REPORT.md](load-tests/REPORT.md); `LEARNING-LOG.md` 2026-11-06 |

## Requirement 1: Pagination

| Must | Status | Evidence |
|---|---|---|
| Cursor pagination on the activity feed, timestamp + ID | ✅ | [ADR 0022](docs/decisions/0022-activity-feed-cursor-index-and-fail-closed.md); `server/src/activity/cursor.ts` |
| Index supporting the cursor query, `EXPLAIN ANALYZE` before/after | ✅ | `npm run db:feed-proof -- explain` (`server/src/db/feed-proof.ts`); index `activity (team_id, created_at DESC, id DESC)` |
| Infinite scroll with FlashList, pull to refresh | ✅ | `docs/ARCHITECTURE.md` section 6, "Team activity" |
| Loading, empty, end-of-list, error states | ✅ | Same section: skeleton rows, "You're all caught up", "No activity yet", "Couldn't load activity" with Try again |
| Prevent duplicate requests on fast scroll | ✅ | Same section: only fetched when `hasNextPage && !isFetchingNextPage` and the last attempt didn't fail |
| Seed ≥10,000 activity records | ✅ | `npm run db:feed-proof -- seed`; also seeded fresh per k6 run (`load-tests/seed-k6-team.ts`) |

## Requirement 2: State management

| Must | Status | Evidence |
|---|---|---|
| TanStack Query for all server data, cache times explained | ✅ | [docs/STATE.md](docs/STATE.md) |
| One client state tool, chosen and explained | ✅ | [ADR 0008](docs/decisions/0008-client-state-zustand.md) — Zustand |
| Optimistic updates with rollback: swaps and settings | ✅ | [PR #50](https://github.com/Hennit-Dave/rota/pull/50) (swaps), [#51](https://github.com/Hennit-Dave/rota/pull/51) (settings) |
| Persist upcoming shifts offline, visible "last updated" | ✅ | [ADR 0034](docs/decisions/0034-offline-upcoming-shifts.md) |
| `STATE.md` mapping data to where it lives | ✅ | [docs/STATE.md](docs/STATE.md) |

## Requirement 3: Authentication

| Must | Status | Evidence |
|---|---|---|
| Email/password + one of Google sign-in or magic link | ✅ (magic link) | [ADR 0020](docs/decisions/0020-password-reset-and-magic-link.md); [PR #45](https://github.com/Hennit-Dave/rota/pull/45) |
| Tokens in `expo-secure-store`, never AsyncStorage [self-study] | ✅ | `docs/SECURITY.md` ("Threat 6"); `LEARNING-LOG.md` 2026-10-22 |
| Short-lived access + refresh tokens, rotation, reuse rejection [self-study] | ✅ | `docs/SECURITY.md` ("Threat 4"); `LEARNING-LOG.md` 2026-10-22 |
| Log out of all devices | ✅ | `POST /auth/logout-all`; `logout.integration.test.ts` |
| Invite flow via deep link into the right team | ✅ | [ADR 0017](docs/decisions/0017-invitations-app-and-the-invite-link.md); [PR #40](https://github.com/Hennit-Dave/rota/pull/40) |
| Password reset, single-use expiring token | ✅ | [ADR 0020](docs/decisions/0020-password-reset-and-magic-link.md) |

## Requirement 4: Security

Covered in full above ("Deliverables checklist" row 7 and `docs/SECURITY.md` itself). The brief's specific asks:

| Must | Status | Evidence |
|---|---|---|
| Server enforces every permission; Postman test for Staff calling delete-shift | ✅ | `shifts.integration.test.ts` ("THE BRIEF") |
| One team never sees another's data | ✅ | `team-security.integration.test.ts` ("TEAM ISOLATION") |
| Zod on the whole request (body, query, params) everywhere, incl. feed cursor/limit | ✅ | Every route; `server/src/http/validate.ts`; `docs/SECURITY.md` |
| Rate limit login, reset, invites, payment, and expensive endpoints (feed) | ✅ | `docs/SECURITY.md` ("Rate limiting") — full table |
| List every `EXPO_PUBLIC_` variable and why it's safe | ✅ | `docs/SECURITY.md` ("Threat 6") — 3 variables, each justified |
| `SECURITY.md` listing 8 threats | ✅ | [docs/SECURITY.md](docs/SECURITY.md) |

## Requirement 5: Payments and proration

| Must | Status | Evidence |
|---|---|---|
| Proration calculated by us, formula + rounding rule documented | ✅ | `docs/ARCHITECTURE.md` section 5h; `server/src/billing/proration.ts` |
| ≥8 proration unit tests (upgrade, downgrade, add/remove seats, first/last day, two changes, +1 more) | ✅ | `server/src/billing/proration.unit.test.ts` — 24 tests, the brief's 8 numbered explicitly, plus 16 more |
| Provider checkout in test mode; server decides success via verified webhook | ✅ | [ADR 0027](docs/decisions/0027-activation-checkout-webhook-and-seat-limits.md); real event proven end to end, deployment-gate check 1, [PR #77](https://github.com/Hennit-Dave/rota/pull/77) |
| Webhook signature verified; processed in a background job; dedup by event ID | ✅ | `server/src/billing/webhook.ts`, `stripeEventJob.ts`; `activation.integration.test.ts` |
| Idempotency keys on every payment request | ✅ | `payment_requests` table; every billing write route |
| Append-only ledger; subscription rebuildable from it | ✅ | [ADR 0026](docs/decisions/0026-billing-engine-and-schema.md); `ledger.unit.test.ts` (`rebuildSubscription`) |
| Seat limits enforced on the server | ✅ | `server/src/billing/seats.ts`; `seats.integration.test.ts` |
| Failed renewal: grace period, Owner notifications, restricted access | ✅ | [ADR 0031](docs/decisions/0031-renewals-and-failed-renewals.md); `renewal.integration.test.ts` |

## Requirement 6: Push notifications

| Must | Status | Evidence |
|---|---|---|
| Register device token after login, linked to user; multiple devices | ✅ | [ADR 0032](docs/decisions/0032-push-notifications-part-1.md); `device_tokens` table |
| Sent from a background job, never in the request | ✅ | `push/jobs.ts`; `AGENTS.md` rule 10 |
| Invalid tokens deleted | ✅ | `push_receipts` sweep, ~15 min later, deletes `DeviceNotRegistered` |
| Tapping opens the exact screen (deep link) | ✅ | Verified with the app open/backgrounded, and from a cold start too, 2026-11-06, real device (ADR 0032) |
| Grouped notification types, each togglable | ✅ | `notifyShiftChanges`, `notifySwapUpdates`, `notifyBilling` settings; one Android channel per type, [ADR 0033](docs/decisions/0033-push-notifications-part-2.md) |
| Quiet hours + time zone respected on the server | ✅ | `settings/quietHours.ts`, called from the push job when it runs |

## Requirement 7: Settings coordination

| Must | Status | Evidence |
|---|---|---|
| Settings on the server (quiet hours, time zone, notifications, language, theme) | ✅ | [ADR 0024](docs/decisions/0024-settings-server-source-of-truth.md) |
| Other devices see changes without reinstalling | ✅ | `app/src/services.ts` wires TanStack's `focusManager` to `AppState`; refetch on foreground and on screen mount (`app/src/settings/useSettings.ts`) |
| Conflict handling: server `updatedAt`, most recent wins, weakness documented | ✅ | [ADR 0024](docs/decisions/0024-settings-server-source-of-truth.md) documents both the rule and its weakness (a device with a wrong clock cannot skew it — the stamp is the server's own) |
| Notification job checks quiet hours/time zone, delays non-urgent | ✅ | Same as Requirement 6 |
| Settings changes are optimistic with rollback | ✅ | [PR #51](https://github.com/Hennit-Dave/rota/pull/51) |

## Task A: backend system design requirements

Same items as "The backend system design standard" above, plus the load test. All ✅ except the load-test
pool-wait gap noted in the deliverables checklist (row 12) and below.

## Known gaps — not yet proven (do not tick these)

1. **k6 report doesn't separately measure database time and pool wait** (`data.md` test 11, second half). The report only has whole-request `http_req_duration`; Neon's pooler-side view shows its own queue, not time spent inside the API process waiting for a client from the pg `Pool`. Tracked as [issue #83](https://github.com/Hennit-Dave/rota/issues/83) — not blocking submission. (The first half of test 11, connections staying within the configured maximums, is now proven: Neon Monitoring shows 1-2 actual Postgres server connections per shard for all 200 VUs, against an 8-per-shard-primary ceiling, with 0.00s pooler wait — see `load-tests/REPORT.md`.)
2. **Rota pinned on GitHub profile, 2×/week LinkedIn posts, 30-company lead tracker** — not verifiable from the repo; ask Dave directly.
3. **Portfolio case study and CV/LinkedIn bullet** — not started.
4. Valkey used in place of the Redis named in the brief; reasoning and one-variable switch-back in ADR 0003; no facilitator sign-off.
