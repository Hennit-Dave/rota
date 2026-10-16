# Rota

Rota is a shift-scheduling mobile app for small teams such as restaurants, clinics and shops.

Design: [Rota screens in Figma](https://www.figma.com/design/scojjuqq2W5nWs7M1i6GrY)

Status: in progress

## Run the server locally

Needs Node 24 (`nvm use` reads `.nvmrc`). Only the API and worker processes exist so far: no database,
queue or features yet.

```sh
cd server
npm ci
npm run build
npm run start:api      # terminal 1: http://localhost:3000/health returns {"ok":true}
npm run start:worker   # terminal 2: logs "worker running"
```

Optional: copy `.env.example` to `.env` at the repo root and set `PORT`. It defaults to 3000.
