import express from 'express';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Health checks never touch Postgres or Valkey (data.md).
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
