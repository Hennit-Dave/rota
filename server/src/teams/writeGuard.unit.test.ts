import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Router } from 'express';
import { loadAuthConfig } from '../auth/config.js';
import { createTeamInvitationsRouter } from '../invites/routes.js';
import { createShiftsRouter } from '../shifts/routes.js';
import { createSwapsRouter } from '../swaps/routes.js';
import { createLogger } from '../http/logger.js';

// The restricted-access guard (ADR 0031) is one named step on every team route that writes. This test walks the real routers, so a new write route that forgets it fails
// here before it can ship. The database-backed behaviour (what the guard actually refuses, and what it lets through) is in renewal.integration.test.ts.
const shards = { A: { primary: {} }, B: { primary: {} } } as never;
const tokens = {} as never;
const limiter = {} as never;
const config = loadAuthConfig();
const logger = createLogger();

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> };
}

function routesOf(router: Router): Array<{ method: string; path: string; steps: string[] }> {
  const out: Array<{ method: string; path: string; steps: string[] }> = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: layer.route.path, steps: layer.route.stack.map((l) => l.handle.name) });
  }
  return out;
}

const routers: Array<[string, Router]> = [
  ['shifts', createShiftsRouter({ shards, tokens })],
  ['swaps', createSwapsRouter({ shards, tokens, limiter, logger, config })],
  ['invitations', createTeamInvitationsRouter({ shards, tokens, limiter, logger, config, invites: {} as never })],
];

test('EVERY team route that writes (shifts, swaps, invitations) has the read-only guard; every read does not', () => {
  let writes = 0;
  for (const [name, router] of routers) {
    const routes = routesOf(router);
    assert.ok(routes.length > 0, `${name} has routes`);
    for (const r of routes) {
      const guarded = r.steps.includes('requireWritable');
      if (r.method === 'GET') assert.equal(guarded, false, `${name} ${r.method} ${r.path}: a read must keep working for a read-only team`);
      else {
        writes += 1;
        assert.equal(guarded, true, `${name} ${r.method} ${r.path} writes and has no requireWritable step`);
      }
    }
  }
  // 3 shifts + 4 swaps (create, cancel, approve, reject) + 4 invitations (link, invite, resend, revoke).
  assert.equal(writes, 11);
});

test('the guard comes AFTER validation, authentication and the membership check on every write route, so a stranger never learns that a team is overdue', () => {
  for (const [name, router] of routers) {
    for (const r of routesOf(router).filter((x) => x.method !== 'GET')) {
      const guard = r.steps.indexOf('requireWritable');
      // validateRequest, requireAuth and requireTeamRole are the first three steps of every team route (security.md); anything may sit between them and the guard.
      assert.ok(guard >= 3, `${name} ${r.method} ${r.path}: the guard is at step ${guard}, before the membership check can have run`);
      assert.ok(guard < r.steps.length - 1, `${name} ${r.method} ${r.path}: the guard must come before the handler`);
    }
  }
});
