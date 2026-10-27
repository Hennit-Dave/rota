# Outreach feature map

Which Rota feature to lead with for which kind of company. Updated when a feature is finished
(`.agents/rules/evidence-capture.md`); outreach points at the feature closest to the company's product.

Rows start as **planned**. A row becomes **ready** only when its evidence exists and is linked.

| Feature | Kind of company | Evidence to show | Status |
|---|---|---|---|
| Shift swap requests with manager approval | Shift-scheduling and workforce tools | PR, clip, test | planned |
| Seat-based billing with server-side proration and an append-only ledger | B2B SaaS with per-seat pricing | PR, proration test results, ledger rebuild test | planned |
| Quiet-hours-aware, time-zone-aware notifications | Anything with on-call or shift staff (healthcare, hospitality, retail) | PR, clip of a delayed notification | planned |
| Cursor-paginated activity feed at 10,000+ records, load tested at 200 users | Any product with large feeds or timelines | `EXPLAIN ANALYZE` before/after, load test report | planned |
| Offline viewing with cross-device settings sync | Mobile-first workforce and field-service tools | PR, offline clip | planned |
| Role-based permissions and team isolation, proven by tests | HR and multi-tenant B2B SaaS | [PR #34](https://github.com/Hennit-Dave/rota/pull/34): isolation across two shards (404), role enforcement (403), demotion with the same token | built (PR #34) |
| Email invitations that send exactly once: single-use hashed tokens, a durable background job with idempotency keys, queue-loss recovery | B2B SaaS with team onboarding, and any product that sends transactional email | [PR #36](https://github.com/Hennit-Dave/rota/pull/36) (server half): a lost invite email on shard B restored by the sweep, one real Resend send, mutation-checked security tests | built (PR #36, server half) |
| Deep-link invitations that survive sign-in and sign-up and land the invitee in the right team, with invite and management screens driven by the server's permission answers | Mobile B2B SaaS with team onboarding, and workforce, hospitality and healthcare tools | [PR #40](https://github.com/Hennit-Dave/rota/pull/40) (app half): clips of six device bugs, each recorded broken then fixed; an invitee accepted into a team on the other shard; a Manager shown an Owner's invitation with no buttons | built (PR #40, app half) |
| A shift calendar that is correct in the team's own time zone (across daylight saving), refuses double-booking under concurrency, and writes its own audit trail in the same transaction | Shift-scheduling, hospitality, healthcare and retail workforce tools | [PR #47](https://github.com/Hennit-Dave/rota/pull/47): ADR 0021; five simultaneous bookings of one person give exactly one (test); week windows across a clock change (unit tests); emulator screenshots | built (PR #47) |

The first three starting rows come from the build prompt; the rest are proposals. Edit freely; only
measured, linked evidence goes in the evidence column.
