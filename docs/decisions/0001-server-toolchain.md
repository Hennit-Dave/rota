# 0001: Server toolchain (TypeScript 6.0.3, ESM, Node 24)

- **Status:** accepted
- **Date:** 2026-10-16
- **Decided by:** Dave
- **Related:** `.agents/rules/observability.md`, `.agents/rules/git-and-process.md`, scaffold slice (`chore/scaffold`)

## Problem

The server scaffold needs a language version, a module system, a way to run TypeScript while developing, and
a Node version to pin. These choices touch every later slice, so they are recorded now. The TypeScript
version is the one with a real trade-off: the registry's newest line is 7.x, but the tools we will add next
may not support it.

## Options considered

1. **TypeScript 7.0.2** (newest, released 2026-07-08): the current `latest`. Risk: other tools read
   TypeScript's own code, and they declare which versions they work with.
2. **TypeScript 6.0.3** (released 2026-04-16): the last 6.x release. Older, but inside the range the
   tools we plan to add declare.
3. **Module system, ESM vs CommonJS:** ESM is the current JavaScript standard but needs `.js` on relative
   imports. CommonJS avoids that but is the older format. Not checked: how each library we plan to add
   (Prisma 7, BullMQ) handles each format; ESM is the default for new Node code.
4. **Running TypeScript in development, `tsx` vs Node's built-in type stripping:** `tsx` accepts all
   TypeScript syntax and watches files. Type stripping needs no extra package but rejects some syntax.

## Decision

- **TypeScript 6.0.3**, pinned exactly.
- **ESM** (`"type": "module"`, `module: nodenext`).
- **tsx 4.23.15** for `dev:*` scripts; `tsc` builds `dist/` for `start:*`.
- **Node 24.x**: `"engines": { "node": "24.x" }` in `server/package.json` and `24` in `.nvmrc` at the repo root.
  `@types/node` is the 24.x line (24.19.2), not the registry's newest 26.x, so the types match the runtime.
- **npm**, with exact versions (no `^`) and a committed `package-lock.json`.
- **Express 5.3.0.** Its release notes include the `qs` and `proxy-addr` security fixes that 5.2.1 lacks, it
  is not deprecated, and GitHub lists no advisory against it.
- **Local `.env`** is loaded by Node itself (`--env-file-if-exists=../.env`), so there is no `dotenv` package.
- **No logger yet.** The logger is chosen in the Sentry and request-ID logging slice (build order step 3),
  with its own ADR. The scaffold uses plain `console.log`.

## Why

Verified on 2026-10-16 from the npm registry:

- `typescript-eslint` 8.71.2 declares the peer range `typescript: >=4.8.4 <6.1.0`. It does **not** support
  TypeScript 7. We will want linting, so TypeScript 7 would break that tool.
- `@prisma/client` 7.10.1 (npm `latest`) declares `typescript: >=5.4.0`, with no upper bound. A peer range
  is not a statement of official support, and I did not read Prisma's documentation for one. It was not
  needed to decide, because the typescript-eslint failure was enough.

Assumed, not verified: that TypeScript 6.0.3 builds everything we add later. It builds this scaffold cleanly.

## Consequences

- **Easier:** one TypeScript version that the lint and ORM tools we plan to add accept.
- **Harder or given up:** TypeScript 7's faster compiler. We stay one major version behind `latest`.
- **Revisit when** both are true: typescript-eslint's peer range includes 7.x, and Prisma's documentation
  states support for TypeScript 7. Check at the lint slice, and again before the first Prisma slice. Moving
  to 7 means a new ADR that supersedes this one.
- `fsevents` and `esbuild` install scripts are blocked by npm 12's default. `tsx` works without them
  (verified). If a later package needs a script to run, approve it with `npm install-scripts approve`.

## Evidence

- `npm run typecheck` and `npm run build` pass on TypeScript 6.0.3 after a clean `npm ci`.
- `npm audit`: 0 vulnerabilities. Full output is in the scaffold PR.
