# 0036: One container image for the API and the worker

- **Status:** accepted (2026-11-04)
- **Date:** 2026-11-04
- **Decided by:** Dave
- **Related:** issue #14 (closes), issue #7 (provider), `server/Dockerfile`, `.agents/rules/data.md` (one-process rule)

## Problem

The server has to be packaged so a host can run it. It has two programs (the API and the worker), and the host is
not chosen in this PR's code: the image must not assume one.

## Options considered

1. **One image, two start commands.** The API is the default command; the worker is the same image started with
   `node dist/worker/main.js`. One build, one set of dependencies, one thing to scan and version.
2. **Two images.** Each smaller, but two Dockerfiles that drift, and two builds for one codebase.
3. **Build on the host from source** (no Dockerfile, the host's own buildpack). Less to write, but the build becomes
   provider-specific, which the issue asks us to avoid.

## Decision

Option 1: `server/Dockerfile`, build context `server/`, two stages. The build stage installs everything, generates the
Prisma client and compiles TypeScript. The runtime stage installs production dependencies only (`--omit=dev
--ignore-scripts`) and copies `dist/`.

## Why

- **Debian slim, not Alpine.** `@node-rs/argon2` ships a prebuilt binary per platform; the glibc one is the common case
  and avoids the musl variant. `node:24.22.2-bookworm-slim` exists for amd64 and arm64 (checked on Docker Hub,
  2026-11-04), and Node 24 matches `.nvmrc` and `engines`. The exact patch is pinned so two builds of the same commit
  use the same Node.
- **No secrets, no `.env` in the image.** Every setting is a runtime environment variable named in `.env.example`.
  `.dockerignore` also excludes `.env*`, so a local file cannot be copied in by accident.
- **Migrations are not run by the image.** They run from a developer machine through the direct URL on both shards
  (`data.md`), shard A first. A container that migrates on start would run it once per instance and through the
  pooler's rules, which `server/AGENTS.md` forbids for the migration engine.
- **Runs as the `node` user, exec-form `CMD`.** Not root. `node` is PID 1, so SIGTERM reaches it directly and both programs
  run their own graceful shutdown (the API drains requests and tasks; the worker stops the reconciler, the consumer and
  closes its connections). Going through `npm start` would put a shell in between and swallow the signal.
- **No `HEALTHCHECK` instruction.** The worker has no HTTP port, so an image-level check would mark it unhealthy. The
  API's health check is configured on the host against `GET /health`.

## Consequences

- One build serves both services. A host sets the start command for the worker service.
- The prisma CLI package is present in the runtime image because `@prisma/client` lists it as a peer dependency, so the
  image is larger than it needs to be (about 370 MB of `node_modules`). Nothing runs it. Trimming it is an
  optimisation for later, not a risk.
- The image is built for the platform of the machine that builds it. A host builds it for its own platform.
- Revisit if the worker's needs diverge from the API's (for example a different memory profile), which would argue for two
  images.

## Evidence

- Checked without Docker (not installed on the author's machine): both stages replayed by hand (`npm ci`, `npm run
  build`, `npm ci --omit=dev --ignore-scripts`), the compiled API started from the runtime tree with an empty
  environment plus the test-shard variables, `GET /health` returned 200, and SIGTERM closed it in about 2 seconds.
  `npm ci --os=linux --cpu=x64|arm64 --libc=glibc` installs the matching argon2 binary from the lockfile.
- `.github/workflows/docker.yml` runs a real `docker build`, starts the API with placeholder values, calls `GET /health`, stops it with
  `docker stop` and requires exit code 0 (graceful shutdown as PID 1), checks the user is not root, and checks the worker command starts. The
  green run is linked in the PR.
