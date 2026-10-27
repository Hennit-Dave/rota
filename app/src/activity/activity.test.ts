import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createActivityApi } from './activityApi';
import { activityCopy } from './activityCopy';
import { feedState, flattenPages, keepFirstPage, mayFetchNextPage, nextPageParam, type Pages } from './activityPaging';
import { activityKey, parseActivityPage, type ActivityItem } from './activityResponses';
import { activityDetail, activityLabel } from './activityText';

const TEAM = '11111111-1111-4111-8111-111111111111';
const row = (n: number, over: Partial<Record<string, unknown>> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind: 'shift_created',
  createdAt: '2031-03-04T08:42:00.000Z',
  actor: { id: 'u1', name: 'Daniel Mensah' },
  shiftId: 's1',
  shift: { title: 'Morning service', startsAt: '2031-03-04T09:00:00.000Z', endsAt: '2031-03-04T17:00:00.000Z' },
  changed: [],
  ...over,
});
const item = (n: number, over: Partial<Record<string, unknown>> = {}) => parseActivityPage({ items: [row(n, over)], nextCursor: null }).items[0] as ActivityItem;

test('list: GET with the team in the path; no limit and no cursor on the first page; nothing else is ever sent', async () => {
  const h = makeHarness({ handler: () => json(200, { items: [row(1)], nextCursor: 'abc_-123' }) });
  const page = await createActivityApi(h.client).list(TEAM, {});
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, 'abc_-123');
  assert.equal(h.calls[0]?.method, 'GET');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/activity`);
  assert.equal(h.calls[0]?.search, '');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('list: the cursor is handed back exactly as the server gave it; a limit is only sent when asked for', async () => {
  const h = makeHarness({ handler: () => json(200, { items: [], nextCursor: null }) });
  const api = createActivityApi(h.client);
  await api.list(TEAM, { cursor: 'eyJ0IjoiMSJ9', limit: 20 });
  await api.list(TEAM, { cursor: null });
  assert.equal(h.calls[0]?.search, '?limit=20&cursor=eyJ0IjoiMSJ9');
  assert.equal(h.calls[1]?.search, '');
});

test('list: an ID with odd characters cannot change the path, and server errors reach the screen with the request ID', async () => {
  const h = makeHarness({ handler: () => json(429, { error: { code: 'rate_limited', message: 'x', requestId: 'req-3' } }, { 'X-Request-Id': 'req-3', 'Retry-After': '30' }) });
  await assert.rejects(createActivityApi(h.client).list('../members', {}), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 429);
    assert.equal(e.requestId, 'req-3');
    return true;
  });
  assert.equal(h.calls[0]?.path, '/teams/..%2Fmembers/activity');
});

test('answers that cannot be read throw invalid_response: a bad kind, time, actor, snapshot, changed list, cursor, or half a page', () => {
  const bad: unknown[] = [
    null,
    {},
    { items: 'x', nextCursor: null },
    { items: [], nextCursor: 5 },
    { items: [], nextCursor: undefined },
    { items: [row(1, { kind: 'shift_published' })], nextCursor: null },
    { items: [row(1, { createdAt: 'yesterday' })], nextCursor: null },
    { items: [row(1, { actor: { id: 1 } })], nextCursor: null },
    { items: [row(1, { shift: { title: 5 } })], nextCursor: null },
    { items: [row(1, { changed: 'title' })], nextCursor: null },
    { items: [row(1, { shiftId: 7 })], nextCursor: null },
    { items: [row(1), { id: 'x' }], nextCursor: null },
  ];
  for (const body of bad) {
    assert.throws(() => parseActivityPage(body), (e) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(body));
  }
  // The gone-account and gone-snapshot cases are valid answers.
  const ok = parseActivityPage({ items: [row(1, { actor: null, shift: null, shiftId: null })], nextCursor: null });
  assert.equal(ok.items[0]?.actor, null);
  assert.equal(ok.items[0]?.shift, null);
});

test('the query key carries the user and the team, so sign-out clears it and another account can never read it', () => {
  assert.deepEqual(activityKey('u1', 't1'), ['activity', 'u1', 't1']);
  assert.notDeepEqual(activityKey('u1', 't1'), activityKey('u2', 't1'));
});

test('label: what happened and to which shift; a row with no readable snapshot still says what kind of change it was', () => {
  assert.equal(activityLabel(item(1)), 'New shift: Morning service');
  assert.equal(activityLabel(item(2, { kind: 'shift_updated' })), 'Shift changed: Morning service');
  assert.equal(activityLabel(item(3, { kind: 'shift_deleted' })), 'Shift removed: Morning service');
  assert.equal(activityLabel(item(4, { shift: null })), activityCopy.createdUntitled);
  assert.equal(activityLabel(item(5, { kind: 'shift_updated', shift: null })), activityCopy.updatedUntitled);
  assert.equal(activityLabel(item(6, { kind: 'shift_deleted', shift: null })), activityCopy.deletedUntitled);
});

test('detail: "Today"/"Yesterday" are the TEAM\'s days, the person is a first name, older rows show the date', () => {
  const LAGOS = 'Africa/Lagos'; // UTC+1
  const now = new Date('2031-03-04T20:00:00.000Z'); // 21:00 on 4 March in Lagos
  assert.equal(activityDetail(item(1), now, LAGOS), 'Today, 09:42 · Daniel');
  assert.equal(activityDetail(item(2, { createdAt: '2031-03-03T15:05:00.000Z' }), now, LAGOS), 'Yesterday, 16:05 · Daniel');
  assert.equal(activityDetail(item(3, { createdAt: '2031-03-01T08:20:00.000Z' }), now, LAGOS), 'Saturday, 1 March, 09:20 · Daniel');
  assert.equal(activityDetail(item(4, { actor: null }), now, LAGOS), 'Today, 09:42');
  // 23:30 UTC on the 4th is 00:30 on the 5th in Lagos: "today" for a Lagos team at 06:00 on the 5th, though the phone may still say the 4th.
  const lateNight = item(5, { createdAt: '2031-03-04T23:30:00.000Z' });
  assert.equal(activityDetail(lateNight, new Date('2031-03-05T05:00:00.000Z'), LAGOS), 'Today, 00:30 · Daniel');
  assert.equal(activityDetail(lateNight, new Date('2031-03-05T05:00:00.000Z'), 'UTC'), 'Yesterday, 23:30 · Daniel');
});

test('nextPageParam: the server cursor, or undefined at the end (that is how the list learns it has ended)', () => {
  assert.equal(nextPageParam({ items: [], nextCursor: 'c1' }), 'c1');
  assert.equal(nextPageParam({ items: [], nextCursor: null }), undefined);
});

test('APP-STATE TEST 16: the next page is asked for only with a next page, none on its way, and no failed attempt waiting for "Try again"', () => {
  const ok = { hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false };
  assert.equal(mayFetchNextPage(ok), true);
  assert.equal(mayFetchNextPage({ ...ok, isFetchingNextPage: true }), false, 'a request is already on its way: fast scrolling sends no duplicate');
  assert.equal(mayFetchNextPage({ ...ok, hasNextPage: false }), false, 'the end of the list');
  assert.equal(mayFetchNextPage({ ...ok, isFetchNextPageError: true }), false, 'no retry loop after a failure');
});

test('flattenPages: every page in order, and a row served twice is shown once', () => {
  const p = (...ns: number[]) => ({ items: ns.map((n) => item(n)), nextCursor: null });
  const data: Pages = { pages: [p(1, 2), p(3, 4), p(4, 5)], pageParams: [null, 'c1', 'c2'] };
  assert.deepEqual(flattenPages(data).map((i) => i.id.slice(-2)), ['01', '02', '03', '04', '05']);
  assert.deepEqual(flattenPages(undefined), []);
});

test('keepFirstPage: a refresh starts again from page one, with the cursor list trimmed to match', () => {
  const p = (n: number) => ({ items: [item(n)], nextCursor: `c${n}` });
  const data: Pages = { pages: [p(1), p(2), p(3)], pageParams: [null, 'c1', 'c2'] };
  assert.deepEqual(keepFirstPage(data), { pages: [p(1)], pageParams: [null] });
  const one: Pages = { pages: [p(1)], pageParams: [null] };
  assert.equal(keepFirstPage(one), one);
  assert.equal(keepFirstPage(undefined), undefined);
});

test('feedState: the four bodies (loading, error, empty, items); an error never replaces rows already on screen', () => {
  const base = { hasData: false, itemCount: 0, isError: false, isFetching: true };
  assert.equal(feedState(base), 'loading');
  assert.equal(feedState({ ...base, isError: true, isFetching: false }), 'error');
  assert.equal(feedState({ ...base, hasData: true, isFetching: false }), 'empty');
  assert.equal(feedState({ ...base, hasData: true, itemCount: 3 }), 'items');
  assert.equal(feedState({ ...base, hasData: true, itemCount: 3, isError: true, isFetching: false }), 'items');
});

test('A QUERY THAT IS NEITHER FETCHING NOR FAILED is never "loading" (it would wait for ever): it is an error with Try again', () => {
  assert.equal(feedState({ hasData: false, itemCount: 0, isError: false, isFetching: false }), 'error');
});

test('the mechanism, with the real TanStack core: a retry paused while the app is not focused leaves the query pending and NOT fetching, and resetting it recovers', async () => {
  const { QueryClient, InfiniteQueryObserver, focusManager } = await import('@tanstack/query-core');
  const client = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 1 } } });
  let calls = 0;
  let healthy = false;
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ['activity', 'u', 't'],
    networkMode: 'always',
    initialPageParam: null as string | null,
    getNextPageParam: () => undefined,
    queryFn: async () => {
      calls++;
      if (!healthy) throw new Error('connection failed');
      return { items: [], nextCursor: null };
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    focusManager.setFocused(false); // the app is not in the foreground (a system dialog, the shade)
    await new Promise((r) => setTimeout(r, 60));
    const stuck = observer.getCurrentResult();
    assert.equal(stuck.status, 'pending', 'no data and no error yet');
    assert.equal(stuck.fetchStatus, 'paused', 'the retry is waiting for the foreground');
    assert.equal(stuck.isFetching, false);
    assert.equal(feedState({ hasData: stuck.data !== undefined, itemCount: 0, isError: stuck.isError, isFetching: stuck.isFetching }), 'error');

    // Try again: reset, and the query starts from nothing.
    healthy = true;
    focusManager.setFocused(true);
    await client.resetQueries({ queryKey: ['activity', 'u', 't'] });
    assert.equal(observer.getCurrentResult().status, 'success');
    assert.ok(calls >= 2);
  } finally {
    focusManager.setFocused(undefined);
    unsubscribe();
    client.clear();
  }
});
