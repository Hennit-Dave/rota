# Rota server image (issue #14). One image, two processes:
#   API    (default)            docker run <image>
#   worker                      docker run <image> node --enable-source-maps dist/worker/main.js
# The build context is server/ (docker build -t rota-server server). The image holds no secrets and no .env file: every
# setting is a runtime environment variable named in .env.example. Database migrations are NOT run from the image: they
# run from a developer machine through the direct URL on both shards (data.md). (The prisma CLI package is present in the
# image only because @prisma/client lists it as a peer dependency; nothing here runs it.)
#
# Provider-neutral on purpose: nothing here assumes Northflank or any other host.
#
# Base: Debian (glibc), not Alpine. @node-rs/argon2 ships a prebuilt binary per platform and musl needs a different one.
# 24.22.2 is Node 24 (.nvmrc, package.json "engines"), checked on Docker Hub for amd64 and arm64.

# ---- build: all dependencies, generate the Prisma client, compile TypeScript ----
FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
# "prebuild" runs db:generate first (it sets a placeholder URL; generating needs no database), then tsc writes dist/.
RUN npm run build

# ---- runtime: production dependencies and the compiled output only ----
FROM node:24.22.2-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency runs code at install time. Nothing here needs it (argon2 arrives as a prebuilt package).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# The official image's "node" user (uid 1000): the process never runs as root.
USER node
# The API reads PORT (default 3000). The worker listens on nothing.
EXPOSE 3000
# Exec form, calling node directly: SIGTERM reaches the process itself, so both programs run their graceful shutdown.
# No HEALTHCHECK here: the worker runs from this same image and has no HTTP port, so an image-level check would mark it
# unhealthy. The host's health check for the API service uses GET /health.
CMD ["node", "--enable-source-maps", "dist/api/main.js"]
