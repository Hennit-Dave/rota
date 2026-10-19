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
npm test
npm run start:api      # terminal 1: http://localhost:3000/health returns {"ok":true}
npm run start:worker   # terminal 2: logs "worker running"
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
| `npm run jobs:prove:boxes-4-5` | `VALKEY_URL`, `SHARD_A_DATABASE_URL` | Proves Box 4 (immediate execution with timing) and Box 5 (delayed fire and exponential backoff) |
| `npm run jobs:prove:crash` | `VALKEY_URL`, `SHARD_A_DATABASE_URL` | Proves Box 6 (abrupt SIGKILL termination mid-claim and recovery upon lease expiry) |

