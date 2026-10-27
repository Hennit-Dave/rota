import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { shardFor } from '../db/shard.js';
import { bearer, startTeamsTestApp, type TeamsTestApp } from '../teams/testkit.js';
import { encodeCursor } from './cursor.js';

// The activity feed (ADR 0022; brief requirement 1: cursor paging with (created_at, id), brief requirement 4: one team never sees another's data).
// The TEST shards, real Valkey, real HTTP. Rows are written either through the shift routes (the real writers) or straight into `activity` so that
// timestamps and ties are exactly what a test needs.
let app: TeamsTestApp;
before(async () => {
  app = await startTeamsTestApp();
});
after(() => app.stop());

const db = (teamId: string) => app.raw[shardFor(teamId)].primary;
const feedUrl = (teamId: string, query = '') => `/teams/${teamId}/activity${query}`;
const strip = (r: { body: { error: Record<string, unknown> } }) => ({ ...r.body.error, requestId: '<id>' });

async function setup(opts: { shard?: 'A' | 'B' } = {}) {
  const owner = await app.seedUser('Olive Owner');
  const { teamId, shard } = await app.seedTeam({ ownerId: owner.id, shard: opts.shard, name: 'The Olive Room' });
  const manager = await app.seedUser('Maya Manager');
  await app.addMember(teamId, manager.id, 'manager');
  const staff = await app.seedUser('Sam Staff');
  await app.addMember(teamId, staff.id, 'staff');
  const h = async (id: string) => bearer((await app.signIn(id)).accessToken);
  return { teamId, shard, owner, manager, staff, ownerH: await h(owner.id), managerH: await h(manager.id), staffH: await h(staff.id), h };
}

/** Rows with chosen timestamps: `minutes` is how many minutes after a fixed far-future instant. Ids are fixed so order within a tie is known. */
const BASE = Date.UTC(2031, 2, 4, 9, 0);
/** Unique per team (the primary key is global) and ordered by `n` within a team, so the order inside a tie is known. */
const rowId = (teamId: string, n: number) => `${teamId.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function insertRows(teamId: string, actor: string, rows: Array<{ n: number; minutes: number; ms?: number }>) {
  for (const r of rows) {
    await db(teamId).$executeRaw`
      INSERT INTO activity (id, team_id, created_at, actor_user_id, kind, shift_id, data)
      VALUES (${rowId(teamId, r.n)}::uuid, ${teamId}::uuid, ${new Date(BASE + r.minutes * 60_000 + (r.ms ?? 0)).toISOString()}::timestamptz, ${actor}::uuid,
              'shift_created'::activity_kind, NULL, ${JSON.stringify({ title: `Shift ${r.n}`, startsAt: '2031-03-04T09:00:00.000Z', endsAt: '2031-03-04T17:00:00.000Z' })}::jsonb)`;
  }
}

/** The order the feed promises: created_at descending, then id descending. */
const feedOrder = (teamId: string, rows: Array<{ n: number; minutes: number; ms?: number }>) =>
  [...rows].sort((a, b) => b.minutes * 60_000 + (b.ms ?? 0) - (a.minutes * 60_000 + (a.ms ?? 0)) || (b.n > a.n ? 1 : -1)).map((r) => rowId(teamId, r.n));

async function pageAll(teamId: string, headers: Record<string, string>, limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const res = await app.get(feedUrl(teamId, `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`), headers);
    assert.equal(res.status, 200);
    pages.push((res.body.items as Array<{ id: string }>).map((i) => i.id));
    cursor = res.body.nextCursor;
    if (cursor === null) return pages;
  }
  throw new Error('paging never ended');
}

test('the shift routes write the feed: newest first, with who did it, what, and which fields an edit changed; every member may read it', async () => {
  const t = await setup({ shard: 'B' });
  const a = await app.post(`/teams/${t.teamId}/shifts`, { title: 'Morning service', startsAt: '2031-03-04T09:00:00.000Z', endsAt: '2031-03-04T17:00:00.000Z', assignedUserId: t.staff.id }, t.managerH);
  assert.equal(a.status, 201);
  const id = a.body.shift.id as string;
  assert.equal((await app.patch(`/teams/${t.teamId}/shifts/${id}`, { title: 'Brunch service', note: 'Bring menus' }, t.ownerH)).status, 200);
  assert.equal((await app.del(`/teams/${t.teamId}/shifts/${id}`, t.ownerH)).status, 204);

  for (const headers of [t.staffH, t.managerH, t.ownerH]) {
    const res = await app.get(feedUrl(t.teamId), headers);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.body.nextCursor, null, 'three rows fit one page');
    const items = res.body.items as Array<{ kind: string; actor: { name: string } | null; shift: { title: string } | null; changed: string[]; shiftId: string; createdAt: string }>;
    assert.deepEqual(items.map((i) => i.kind), ['shift_deleted', 'shift_updated', 'shift_created'], 'newest first');
    assert.deepEqual(items.map((i) => i.actor?.name), ['Olive Owner', 'Olive Owner', 'Maya Manager']);
    assert.deepEqual(items.map((i) => i.shift?.title), ['Brunch service', 'Brunch service', 'Morning service'], 'each row keeps the snapshot of its moment');
    assert.deepEqual(items[1]!.changed.sort(), ['note', 'title']);
    assert.ok(items.every((i) => i.shiftId === id));
    assert.match(items[0]!.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
});

test('paging: pages of the asked size, a null cursor on the last page, every row exactly once and in (created_at, id) order', async () => {
  const t = await setup({ shard: 'A' });
  const rows = Array.from({ length: 45 }, (_, k) => ({ n: k + 1, minutes: k }));
  await insertRows(t.teamId, t.owner.id, rows);
  const pages = await pageAll(t.teamId, t.staffH, 20);
  assert.deepEqual(pages.map((p) => p.length), [20, 20, 5], 'the extra row used to detect a next page is never returned');
  assert.deepEqual(pages.flat(), feedOrder(t.teamId, rows));
  assert.equal(new Set(pages.flat()).size, 45);

  // A page that is exactly full has no next page: no empty trailing page.
  const exact = await pageAll(t.teamId, t.staffH, 15);
  assert.deepEqual(exact.map((p) => p.length), [15, 15, 15]);
  // The default page is 20 and the largest allowed is 50.
  assert.equal(((await app.get(feedUrl(t.teamId), t.staffH)).body.items as unknown[]).length, 20);
  assert.equal(((await app.get(feedUrl(t.teamId, '?limit=50'), t.staffH)).body.items as unknown[]).length, 45);
});

test('TIES: rows that share one created_at are neither skipped nor repeated, even when a page boundary falls inside the tie', async () => {
  const t = await setup();
  // 6 rows at the same millisecond in the middle, 3 newer and 3 older around them.
  const rows = [
    { n: 1, minutes: 0 }, { n: 2, minutes: 1 }, { n: 3, minutes: 2 },
    { n: 10, minutes: 5 }, { n: 11, minutes: 5 }, { n: 12, minutes: 5 }, { n: 13, minutes: 5 }, { n: 14, minutes: 5 }, { n: 15, minutes: 5 },
    { n: 20, minutes: 9 }, { n: 21, minutes: 10 }, { n: 22, minutes: 11 },
  ];
  await insertRows(t.teamId, t.owner.id, rows);
  for (const limit of [1, 2, 4, 5, 7]) {
    const pages = await pageAll(t.teamId, t.staffH, limit);
    assert.deepEqual(pages.flat(), feedOrder(t.teamId, rows), `limit ${limit}: exactly once, in order`);
  }
});

test('NEW ACTIVITY WHILE PAGING causes no repeats and no gaps: the bookmark is a row, not a position', async () => {
  const t = await setup();
  const rows = Array.from({ length: 30 }, (_, k) => ({ n: k + 1, minutes: k }));
  await insertRows(t.teamId, t.owner.id, rows);
  const first = await app.get(feedUrl(t.teamId, '?limit=10'), t.staffH);
  const firstIds = (first.body.items as Array<{ id: string }>).map((i) => i.id);

  // Three newer rows arrive after page 1 was served (offset paging would now repeat three rows of page 1 on page 2).
  const fresh = [{ n: 31, minutes: 100 }, { n: 32, minutes: 101 }, { n: 33, minutes: 102 }];
  await insertRows(t.teamId, t.owner.id, fresh);

  const rest: string[] = [];
  let cursor: string | null = first.body.nextCursor;
  while (cursor) {
    const res = await app.get(feedUrl(t.teamId, `?limit=10&cursor=${cursor}`), t.staffH);
    rest.push(...(res.body.items as Array<{ id: string }>).map((i) => i.id));
    cursor = res.body.nextCursor;
  }
  assert.deepEqual([...firstIds, ...rest], feedOrder(t.teamId, rows), 'the original 30 rows, once each, none missing');
  assert.equal(rest.filter((id) => firstIds.includes(id)).length, 0, 'nothing from page 1 repeats');
  const reload = await app.get(feedUrl(t.teamId, '?limit=3'), t.staffH);
  assert.deepEqual((reload.body.items as Array<{ id: string }>).map((i) => i.id), feedOrder(t.teamId, fresh), 'a refresh shows the new rows on top');
});

test('validation: limit above the maximum, zero, negative, fractional, not a number, and unknown parameters are 400 (nothing echoed, nothing read)', async () => {
  const t = await setup();
  await insertRows(t.teamId, t.owner.id, [{ n: 1, minutes: 0 }]);
  const tooBig = await app.get(feedUrl(t.teamId, '?limit=51'), t.staffH);
  assert.equal(tooBig.status, 400);
  assert.deepEqual(tooBig.body.error.details, [{ path: 'query.limit', code: 'limit_too_large', max: 50 }]);
  for (const bad of ['?limit=0', '?limit=-1', '?limit=1.5', '?limit=abc', '?limit=', '?limit=007x', '?limit=999999999999', '?page=2', '?limit=5&offset=10', '?cursor=', '?limit=5&limit=6']) {
    const res = await app.get(feedUrl(t.teamId, bad), t.staffH);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error.code, 'validation_failed', bad);
  }
  const badTeam = await app.get('/teams/not-a-uuid/activity', t.staffH);
  assert.equal(badTeam.status, 400);
});

test('a TAMPERED cursor is a 400 whatever is wrong with it, and the answer never echoes it', async () => {
  const t = await setup();
  await insertRows(t.teamId, t.owner.id, [{ n: 1, minutes: 0 }]);
  const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const good = { t: '2031-03-04T09:00:00.000Z', i: rowId(t.teamId, 1) };
  const real = encodeCursor({ t: new Date(good.t), i: good.i });
  assert.equal((await app.get(feedUrl(t.teamId, `?cursor=${real}`), t.staffH)).status, 200, 'the control: a genuine cursor works');

  const bad: Record<string, string> = {
    'not base64url': 'this is not a cursor!',
    'plain text': 'hello',
    'base64 of text, not JSON': b64('hello'),
    'JSON array': b64([good.t, good.i]),
    'JSON string': b64('"x"'),
    'JSON null': b64('null'),
    'extra key': b64({ ...good, team: t.teamId }),
    'missing i': b64({ t: good.t }),
    'missing t': b64({ i: good.i }),
    'time without milliseconds': b64({ ...good, t: '2031-03-04T09:00:00Z' }),
    'time with an offset': b64({ ...good, t: '2031-03-04T09:00:00.000+01:00' }),
    'a date that does not exist': b64({ ...good, t: '2031-02-30T09:00:00.000Z' }),
    'time as a number': b64({ ...good, t: 1930000000000 }),
    'id not a uuid': b64({ ...good, i: 'abc' }),
    'id in upper case': b64({ ...good, i: 'ABCDEF00-0000-4000-8000-000000000001' }),
    'id as a number': b64({ ...good, i: 5 }),
    'a SQL fragment in the id': b64({ ...good, i: `${good.i}'; DROP TABLE activity;--` }),
    'too long': 'A'.repeat(500),
    'one character flipped': real.slice(0, -2) + (real.endsWith('A') ? 'B' : 'A') + real.slice(-1),
    'padding added': `${real}==`,
  };
  for (const [label, cursor] of Object.entries(bad)) {
    const res = await app.get(feedUrl(t.teamId, `?cursor=${encodeURIComponent(cursor)}`), t.staffH);
    assert.equal(res.status, 400, label);
    assert.deepEqual(res.body.error.details, [{ path: 'query.cursor', code: 'invalid_cursor' }], label);
    assert.equal(JSON.stringify(res.body).includes(cursor), false, `${label}: the input is not echoed`);
  }
  assert.equal(await db(t.teamId).activity.count({ where: { teamId: t.teamId } }), 1, 'the table is intact');
});

test("a cursor made from ANOTHER team's rows cannot read that team: it is only ever a position, and the query always filters by the caller's team", async () => {
  const x = await setup({ shard: 'A' });
  const y = await setup({ shard: 'B' });
  await insertRows(x.teamId, x.owner.id, Array.from({ length: 5 }, (_, k) => ({ n: 100 + k, minutes: k })));
  await insertRows(y.teamId, y.owner.id, Array.from({ length: 5 }, (_, k) => ({ n: 200 + k, minutes: k })));
  const xPage = await app.get(feedUrl(x.teamId, '?limit=2'), x.staffH);
  const xCursor = xPage.body.nextCursor as string;

  const res = await app.get(feedUrl(y.teamId, `?cursor=${xCursor}`), y.staffH);
  assert.equal(res.status, 200);
  const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
  assert.ok(ids.length > 0);
  for (const id of ids) assert.ok(id.startsWith(y.teamId.slice(0, 8)), `${id} belongs to team Y`);
  assert.ok(!ids.some((id) => id.startsWith(x.teamId.slice(0, 8))), "none of X's rows");
});

test("TEAM ISOLATION across shards: a member of team X gets the same 404 on team Y's feed as on a team that does not exist; strangers and no token are refused", async () => {
  const x = await setup({ shard: 'A' });
  const y = await setup({ shard: 'B' });
  await insertRows(y.teamId, y.owner.id, [{ n: 1, minutes: 0 }]);
  const unknown = await app.get(feedUrl(randomUUID()), x.staffH);
  assert.equal(unknown.status, 404);
  for (const [who, headers] of [['staff of X', x.staffH], ['owner of X', x.ownerH]] as const) {
    const res = await app.get(feedUrl(y.teamId), headers);
    assert.equal(res.status, 404, who);
    assert.deepEqual(strip(res), strip(unknown), `${who}: byte-identical to an unknown team`);
    assert.equal(JSON.stringify(res.body).includes(rowId(y.teamId, 1)), false);
  }
  const reverse = await app.get(feedUrl(x.teamId), y.staffH);
  assert.equal(reverse.status, 404);
  assert.equal((await app.get(feedUrl(y.teamId))).status, 401);
  assert.equal((await app.get(feedUrl(y.teamId), { authorization: 'Bearer nonsense' })).status, 401);
});

test('a member removed from the team loses the feed on the very next request (the role is read from the database, not the token)', async () => {
  const t = await setup();
  await insertRows(t.teamId, t.owner.id, [{ n: 1, minutes: 0 }]);
  assert.equal((await app.get(feedUrl(t.teamId), t.staffH)).status, 200);
  await db(t.teamId).membership.deleteMany({ where: { teamId: t.teamId, userId: t.staff.id } });
  assert.equal((await app.get(feedUrl(t.teamId), t.staffH)).status, 404);
});

test('the feed is limited to 120 requests per minute per user (chosen, not measured): the next is 429 with Retry-After; another user is unaffected', async () => {
  const limited = await startTeamsTestApp({ rateLimits: { feedUser: { max: 3, windowSeconds: 60 } } });
  try {
    assert.deepEqual(app.config.rateLimits.feedUser, { max: 120, windowSeconds: 60 }, 'the shipped default');
    const owner = await limited.seedUser('Limit Owner');
    const { teamId } = await limited.seedTeam({ ownerId: owner.id });
    const other = await limited.seedUser('Other');
    await limited.addMember(teamId, other.id, 'staff');
    const h = bearer((await limited.signIn(owner.id)).accessToken);
    for (let i = 1; i <= 3; i++) assert.equal((await limited.get(feedUrl(teamId), h)).status, 200, `request ${i}`);
    const fourth = await limited.get(feedUrl(teamId), h);
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, 'rate_limited');
    assert.ok(Number(fourth.headers.get('retry-after')) >= 1);
    assert.deepEqual(fourth.body.items, undefined, 'a limited request returns no rows');
    const otherH = bearer((await limited.signIn(other.id)).accessToken);
    assert.equal((await limited.get(feedUrl(teamId), otherH)).status, 200, 'the limit is per user');
    assert.equal((await limited.get(`/teams/${teamId}/members`, h)).status, 200, 'other routes are not affected');
  } finally {
    await limited.stop();
  }
});

test('with Valkey down the feed fails CLOSED (issue #11): 503 and no rows, while the routes that do not use the limiter still answer', async () => {
  const dead = await startTeamsTestApp({ deadValkey: true });
  try {
    const owner = await dead.seedUser('Dead Owner');
    const { teamId, shard } = await dead.seedTeam({ ownerId: owner.id });
    await dead.raw[shard].primary.$executeRaw`
      INSERT INTO activity (id, team_id, created_at, actor_user_id, kind, data)
      VALUES (${rowId(teamId, 1)}::uuid, ${teamId}::uuid, now(), ${owner.id}::uuid, 'shift_created'::activity_kind, '{}'::jsonb)`;
    const h = bearer((await dead.signIn(owner.id)).accessToken);
    const res = await dead.get(feedUrl(teamId), h);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.items, undefined);
    assert.equal((await dead.get(`/teams/${teamId}/members`, h)).status, 200, 'reads that need no limiter are unaffected');
  } finally {
    await dead.stop();
  }
});
