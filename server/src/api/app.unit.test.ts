import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from './app.js';

// Northflank's readiness probe calls GET /health every 5 seconds (ADR 0040). If that route touched Postgres, the probe alone would keep
// Neon awake around the clock (data.md: "Health checks never touch Postgres"; ADR 0040, incident). The app here is built with NO
// dependencies at all: no shards, no Valkey connection, no read routing. A /health that needed any of them would fail this test.
test('GET /health answers from an app with no database and no Valkey', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
