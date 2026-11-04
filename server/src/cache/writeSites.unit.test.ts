import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// A guard for the future (caching.md, ADR 0038). The cache is only right if EVERY writer of what it holds replaces the matching generation. Today the writers are
// few and known; this test reads the source and fails when a NEW file writes memberships, shifts, the activity feed or a user's display name without being added
// here with the invalidation that covers it. So a future role change, member removal, display-name change or "apply the reduction" endpoint cannot quietly forget it.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(SRC, f).split(sep).join('/');

// Tests, test kits, proof and seed scripts write rows directly on purpose (the cache's keys expire by TTL), and generated code is not ours.
const EXCLUDED = /(\.test\.ts|testkit\.ts|[-.]proof[^/]*\.ts|proof-[^/]*\.ts|demo-swap\.ts|^generated\/|^testing\/|\/scripts\/)/;
const sources = walk(SRC)
  .map((f) => ({ path: rel(f), text: readFileSync(f, 'utf8') }))
  .filter((f) => !EXCLUDED.test(f.path));

/** What each kind of write looks like in code. */
const WRITES: Array<{ what: string; kinds: string; pattern: RegExp }> = [
  {
    what: 'membership (a member joins, leaves, is deactivated, or changes role)',
    kinds: "'roster'",
    pattern: /\bmembership\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b|INSERT INTO memberships|UPDATE memberships|DELETE FROM memberships/,
  },
  {
    what: 'shift',
    kinds: "'cal' and 'feed'",
    pattern: /\bshift\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b|INSERT INTO shifts|UPDATE shifts|DELETE FROM shifts/,
  },
  {
    what: 'activity (feed) row',
    kinds: "'feed'",
    pattern: /\bactivity\.(create|createMany|update|updateMany|delete|deleteMany)\b|INSERT INTO activity|UPDATE activity|DELETE FROM activity/,
  },
  {
    // The roster, the calendar and the feed all show names. No endpoint changes one today. When one exists it must replace all three generations of every
    // team the person is in (the user-to-team directory on shard A lists them).
    what: "a user's display name",
    kinds: "'roster', 'cal' and 'feed' of every team the person is in",
    pattern: /\buser\.update(Many)?\(\s*\{[\s\S]{0,200}?\bdata\s*:\s*\{[^}]{0,200}\bname\b|UPDATE users SET[^;`]{0,200}\bname\s*=/,
  },
];

/** The files that write, with what covers each one. `covers` must be found in the file (or in the file named by `coveredIn`). */
const REGISTRY: Record<string, { covers: RegExp; atLeast: number; coveredIn?: string; note: string }> = {
  'shifts/service.ts': { covers: /\.invalidate\(teamId, \['cal', 'feed'\]\)/g, atLeast: 3, note: 'create, edit and delete replace the calendar and the feed' },
  'swaps/service.ts': { covers: /\.invalidate\(teamId, /g, atLeast: 2, note: 'a request or rejection replaces the feed; an approval the calendar and the feed' },
  'invites/service.ts': { covers: /\.invalidate\(inv\.teamId, \['roster'\]\)/g, atLeast: 1, note: 'accepting an invitation adds a member' },
  // Written in the WORKER, in the payment path (billing/ is not edited for caching): the worker wraps the stripe_event handler from outside.
  'billing/renewal.ts': {
    covers: /invalidateRosterAfterRenewalPayment\(/g,
    atLeast: 1,
    coveredIn: 'worker/main.ts',
    note: 'a paid renewal can deactivate the members a reduction chose (ADR 0031); the worker replaces the roster generation after the job finishes',
  },
};

// Files that write one of the above but need no invalidation, each with the reason. Adding to this list is a decision, so it is a visible diff. Empty today.
// (Creating a team writes its first membership through a nested create in teams/service.ts, which these text patterns do not match, and needs nothing anyway:
// the team ID is new and server-made, so nothing can be cached under it yet.) The patterns are textual: a write made some other way is not seen.
const NO_INVALIDATION_NEEDED: Record<string, string> = {};

type Source = { path: string; text: string };

/** The files that write cached data and are on neither list. This is the guard; the tests below run it on the real source and on made-up files. */
function unregisteredWriters(files: Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of files) {
    for (const w of WRITES) {
      if (w.pattern.test(text) && !REGISTRY[path] && !NO_INVALIDATION_NEEDED[path]) {
        out.push(
          `${path} writes a ${w.what}. It must replace the cache generation for ${w.kinds} after its transaction commits (cache/store.ts, Invalidator), ` +
            `and be added to REGISTRY in cache/writeSites.unit.test.ts. If it truly needs none, add it to NO_INVALIDATION_NEEDED with the reason.`,
        );
      }
    }
  }
  return [...new Set(out)];
}

describe('every writer of cached data replaces the cache generation (ADR 0038)', () => {
  it('a file that writes memberships, shifts, activity or a display name is either on the registry with its invalidation, or says why it needs none', () => {
    assert.deepEqual(unregisteredWriters(sources), [], 'a NEW writer of cached data forgot to replace the cache generation');
  });

  it('every file on the registry still writes what it is registered for, and its invalidation is really there', () => {
    const byPath = new Map(sources.map((s) => [s.path, s.text]));
    for (const [path, entry] of Object.entries(REGISTRY)) {
      const text = byPath.get(path);
      assert.ok(text, `${path} exists`);
      assert.ok(WRITES.some((w) => w.pattern.test(text)), `${path} still writes cached data, so its registry entry is still needed`);
      const coverText = byPath.get(entry.coveredIn ?? path);
      assert.ok(coverText, `${entry.coveredIn ?? path} exists`);
      const found = coverText.match(entry.covers)?.length ?? 0;
      assert.ok(found >= entry.atLeast, `${entry.coveredIn ?? path} holds the invalidation for ${path} (${entry.note}): found ${found}, need ${entry.atLeast}`);
    }
  });

  it('every "needs none" file really writes something (the list does not rot)', () => {
    const byPath = new Map(sources.map((s) => [s.path, s.text]));
    for (const path of Object.keys(NO_INVALIDATION_NEEDED)) {
      const text = byPath.get(path);
      assert.ok(text && WRITES.some((w) => w.pattern.test(text)), `${path} still writes cached data, so its entry is still needed`);
    }
  });

  it('THE GUARD CAN FAIL: made-up files that write cached data are caught, and the real writers are not', () => {
    const flagged = (path: string, text: string) => unregisteredWriters([{ path, text }]);
    // A future role change or member removal:
    assert.equal(flagged('teams/roles.ts', 'await tx.membership.update({ where: { id }, data: { role } });').length, 1);
    assert.equal(flagged('teams/remove.ts', 'await tx.$executeRaw`DELETE FROM memberships WHERE team_id = ${t}::uuid`').length, 1);
    assert.equal(flagged('teams/remove.ts', 'await prisma.membership.deleteMany({ where: { teamId } })').length, 1);
    // A future "apply the reduction" that deactivates members:
    assert.equal(flagged('billing/apply.ts', 'UPDATE memberships SET deactivated_at = NOW() WHERE team_id = $1').length, 1);
    // A future display-name change, either way it can be written:
    assert.equal(flagged('settings/profile.ts', 'await tx.user.update({ where: { id }, data: { name } });').length, 1);
    assert.equal(flagged('settings/profile.ts', 'await tx.$executeRaw`UPDATE users SET name = ${name}, updated_at = NOW() WHERE id = ${id}::uuid`').length, 1);
    assert.equal(flagged('settings/profile.ts', 'await tx.user.update({ where: { id: userId }, data: { name: input.name, updatedAt: new Date() } });').length, 1);
    assert.equal(flagged('settings/profile.ts', 'await identity.user.updateMany({ where: { id }, data: { email, name } });').length, 1);
    // A new way to change shifts or the feed:
    assert.equal(flagged('shifts/bulk.ts', 'await tx.shift.updateMany({ where: { teamId }, data: { status } })').length, 1);
    assert.equal(flagged('swaps/extra.ts', 'await tx.activity.create({ data })').length, 1);
    // Not writes of cached data: reads, and users' other columns.
    assert.deepEqual(flagged('x/read.ts', 'await prisma.membership.findMany({ where: { teamId } }); await prisma.shift.count()'), []);
    assert.deepEqual(flagged('auth/recovery.ts', 'UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1'), []);
    assert.deepEqual(flagged('auth/x.ts', 'await tx.user.update({ where: { id }, data: { lastLoginAt: now } }); const name = "a";'), []);
    // A registered writer is not flagged.
    assert.deepEqual(flagged('shifts/service.ts', 'await tx.shift.create({ data })'), []);
  });
});

describe('what is never cached stays out of reach (caching.md, "Never cache")', () => {
  it('billing, auth, sessions, settings, push and the job code never import the cache', () => {
    // Only the worker's composition root may (it wraps one handler to INVALIDATE; it never reads).
    const forbidden = /^(billing|auth|settings|push|jobs|db|invites\/tokens|ratelimit)\//;
    const offenders = sources.filter((s) => forbidden.test(s.path) && /from '\.\.\/cache\//.test(s.text)).map((s) => s.path);
    assert.deepEqual(offenders, [], 'these files must not use the cache: sessions, token state, permissions, billing, payment status, credit balances, idempotency records and quiet-hours settings are never cached');
  });

  it('the cache can only hold the three kinds the rules allow', () => {
    const config = readFileSync(join(SRC, 'cache/config.ts'), 'utf8');
    assert.match(config, /CACHE_KINDS = \['roster', 'cal', 'feed'\] as const/);
  });

  it('the invites service imports only the Invalidator type from the cache (it never reads)', () => {
    const text = sources.find((s) => s.path === 'invites/service.ts')!.text;
    const imports = [...text.matchAll(/from '\.\.\/cache\/([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports, ['store.js']);
    assert.match(text, /import type \{ Invalidator \} from '\.\.\/cache\/store\.js'/);
  });
});
