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
npm run start:api      # terminal 1: http://localhost:3000/health returns {"ok":true}. Needs AUTH_JWT_SECRET (see below)
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
| `npm run jobs:prove:boxes-4-5` | `VALKEY_URL`, `SHARD_A_DATABASE_URL`, `SHARD_B_DATABASE_URL` | Proves Box 4 (immediate execution on Shards A & B with timing) and Box 5 (delayed fire strictly at/after run_at, exponential backoff) |
| `npm run jobs:prove:crash` | `VALKEY_URL`, `SHARD_A_DATABASE_URL` | Proves Box 6 (abrupt SIGKILL termination mid-claim and recovery upon lease expiry) |

### Authentication (server only; needs `AUTH_JWT_SECRET`, `VALKEY_URL` and the shard URLs in `.env`)

Email-and-password sign-up with short-lived access tokens, rotating refresh tokens and logout. The API refuses to start
without a signing secret. Routes, error codes and limits: `docs/ARCHITECTURE.md` (section 5) and `docs/SECURITY.md`.

```sh
openssl rand -base64 32   # copy the output into AUTH_JWT_SECRET in the root .env (at least 32 bytes once decoded)
cd server && npm run build && npm run start:api
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests only: no database, no network |
| `npm run test:integration` | Needs the `TEST_*` variables in `.env`. Runs against the **test** shards and real Valkey, one file at a time. The fast integration tests |
| `npm run test:integration:slow` | The concurrency and revocation-race tests (`*.slow.test.ts`). They hold database locks on purpose and take minutes against Neon |
| `npm run test:all` | All three. **Run it before every PR** |

Try it (default port 3000). This writes to the database in `SHARD_A_DATABASE_URL`, which is the real shard A, so use an address you are happy to leave there:

```sh
curl -s -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada Example","email":"ada@example.com","password":"a-long-enough-passphrase"}'
# -> 201 { user, session: { accessToken, accessTokenExpiresAt, refreshToken } }
curl -s localhost:3000/auth/me -H "authorization: Bearer $ACCESS_TOKEN"
curl -s -X POST localhost:3000/auth/refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
curl -s -X POST localhost:3000/auth/logout -H "authorization: Bearer $ACCESS_TOKEN"
```
