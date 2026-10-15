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
| Role-based permissions and team isolation, proven by tests | HR and multi-tenant B2B SaaS | Permission and isolation test results | planned |

The first three starting rows come from the build prompt; the rest are proposals. Edit freely; only
measured, linked evidence goes in the evidence column.
