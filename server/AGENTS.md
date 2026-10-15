# server/ — backend rules (additive to the root AGENTS.md)

These add to the root `AGENTS.md`; they never replace it. If they conflict, stop and ask.
All paths below are relative to the repository root.

**Loading check:** if asked for this folder's rules marker, answer `server-rules-loaded`. The marker exists
only in this file.

## Read before changing code here

| If the change touches… | Read |
|---|---|
| Any route, auth, tokens, invites, validation, rate limits, secrets, logging of sensitive data | `.agents/rules/security.md` |
| Schema, migrations, any query, shard routing, pools, replicas, read-your-own-writes | `.agents/rules/data.md` |
| Prices, proration, Stripe, webhooks, the ledger, renewals | `.agents/rules/money.md` |
| Jobs, the worker, retries, sweeps, push, email | `.agents/rules/jobs.md` |
| Anything stored in Valkey besides jobs | `.agents/rules/caching.md` |
| Logs, request IDs, Sentry, payment tracing | `.agents/rules/observability.md` |

## Server-specific checks before every PR

- Every route follows its pipeline from `security.md` (public auth, invite accept, user, team, webhook).
- Zod covers body, query and route params.
- Every team-scoped query goes through the shard router; raw queries go through the same read-routing
  function as Prisma queries.
- The Stripe webhook route uses `express.raw`, is registered before global `express.json()`, and
  verifies the signature before parsing.
- Work rows are written to Postgres before anything is enqueued. Background work follows `jobs.md`.
  Payment-session creation remains the bounded synchronous Stripe call permitted by the root rules.
- Nothing uses `SET`, `LISTEN`/`NOTIFY`, SQL `PREPARE` or session-level advisory locks through the pooler.
- Migrations run through the direct URL on **both** shards.
- New log fields pass through the shared redaction list.
- The acceptance tests in each affected rules file are added or updated in the same PR.

## Pending

The deployment provider (until approved, nothing assumes Northflank or Oracle). Directory layout and
commands are filled in by the scaffold slice.
