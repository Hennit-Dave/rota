import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MutationObserver, QueryClient, QueryObserver, onlineManager } from '@tanstack/query-core';
import { OfflineError } from './errors';
import { queryClientDefaults } from './queryDefaults';

// The third "query paused offline, the screen waits for ever" bug (the invitation preview, the activity feed, then `/auth/me` and the team list at an offline
// start). These tests fail if the default is ever lost, and if a launch-path query opts back in to pausing.

const SRC = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

test('the defaults say networkMode always for queries and mutations, and mutations never retry', () => {
  assert.equal(queryClientDefaults.queries.networkMode, 'always');
  assert.equal(queryClientDefaults.mutations.networkMode, 'always');
  assert.equal(queryClientDefaults.mutations.retry, 0);
});

test('a query that says NOTHING about networkMode (like /auth/me and the team list) fails at once offline instead of waiting for ever', async () => {
  const client = new QueryClient({ defaultOptions: queryClientDefaults });
  onlineManager.setOnline(false);
  try {
    // Exactly the shape of useMe and useTeams: a key, a function, no networkMode. The API client's own offline check is what throws.
    const observer = new QueryObserver(client, { queryKey: ['me'], queryFn: async () => Promise.reject(new OfflineError()) });
    const result = await new Promise<ReturnType<typeof observer.getCurrentResult>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('still paused: the query never failed')), 500);
      const off = observer.subscribe((r) => {
        if (r.isError) {
          clearTimeout(timer);
          off();
          resolve(r);
        }
      });
    });
    assert.equal(result.status, 'error');
    assert.equal(result.fetchStatus, 'idle', 'not "paused"');
    assert.ok(result.error instanceof OfflineError);
  } finally {
    onlineManager.setOnline(true);
    client.clear();
  }
});

test('the same control without the default really does pause (so the test above can fail)', async () => {
  const client = new QueryClient();
  onlineManager.setOnline(false);
  try {
    const observer = new QueryObserver(client, { queryKey: ['me'], queryFn: async () => Promise.reject(new OfflineError()) });
    const off = observer.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(observer.getCurrentResult().fetchStatus, 'paused');
    off();
  } finally {
    onlineManager.setOnline(true);
    client.clear();
  }
});

test('a mutation that says nothing about networkMode runs and fails at once offline; it is never queued for later', async () => {
  const client = new QueryClient({ defaultOptions: queryClientDefaults });
  onlineManager.setOnline(false);
  let sent = 0;
  try {
    const mutation = new MutationObserver(client, {
      mutationFn: async () => {
        sent += 1;
        throw new OfflineError();
      },
    });
    await assert.rejects(mutation.mutate(), OfflineError);
    assert.equal(sent, 1, 'it ran (and was refused by the API client): it was not parked');
    assert.equal(client.getMutationCache().getAll().filter((m) => m.state.isPaused).length, 0, 'nothing is waiting to be resumed');
    onlineManager.setOnline(true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent, 1, 'coming back online replays nothing');
  } finally {
    onlineManager.setOnline(true);
    client.clear();
  }
});

test('services.ts builds the QueryClient from these defaults, and no source file opts back in to pausing', () => {
  assert.match(readFileSync(join(SRC, 'services.ts'), 'utf8'), /new QueryClient\(\{\s*defaultOptions: queryClientDefaults,/);
  const offenders = files(SRC).filter((f) => /networkMode:\s*['"](online|offlineFirst)['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
