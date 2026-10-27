import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MutationObserver, QueryClient, onlineManager } from '@tanstack/query-core';
import { ApiError, NotSignedInError, OfflineError, SessionEndedError, StaleAccountError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import type { Shift } from '../shifts/shiftResponses';
import { deferred, json, makeHarness } from '../testkit';
import { createSwapApi } from './swapApi';
import { swapFailureCopy } from './swapCopy';
import { describeSwapFailure } from './swapFailure';
import { maySendSwap, optimisticSwap, orderSwaps, replaceSwap, updateSwap, withOptimisticSwap } from './swapOptimistic';
import { parseSwap, parseSwapList, parseSwapResponse, swapsKey, type Swap } from './swapResponses';
import { shiftOptionLabel, shiftWhen, swapDetail, swapHeader, swapLabel, swapReviewDetail } from './swapText';
import { createSwapMutationOptions, type CreateSwapInput } from './swapMutation';

const TEAM = '11111111-1111-4111-8111-111111111111';
const LAGOS = 'Africa/Lagos';

const swapBody = (over: Partial<Record<string, unknown>> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  status: 'pending',
  createdAt: '2031-03-01T10:00:00.000Z',
  decidedAt: null,
  requester: { id: 'u1', name: 'Amara Okafor' },
  counterparty: { id: 'u2', name: 'Daniel Mensah' },
  offered: { shiftId: 's1', title: 'Morning service', area: null, startsAt: '2031-03-04T08:00:00.000Z', endsAt: '2031-03-04T16:00:00.000Z' },
  requested: { shiftId: 's2', title: 'Evening service', area: 'Front of house', startsAt: '2031-03-04T16:00:00.000Z', endsAt: '2031-03-04T21:00:00.000Z' },
  mine: true,
  canCancel: true,
  canDecide: false,
  ...over,
});
const swap = (over: Partial<Record<string, unknown>> = {}) => parseSwap(swapBody(over)) as Swap;

const shift = (id: string, title: string, assignee: { id: string; name: string } | null, startsAt: string, endsAt: string): Shift => ({
  id, title, area: null, startsAt, endsAt, breakMinutes: null, note: null, assignee, status: 'scheduled',
});
const KEY = '33333333-3333-4333-8333-333333333333';

test('create: POST sends only the two shift IDs, the idempotency key as a header, and never who is asking or the other person', async () => {
  const h = makeHarness({ handler: () => json(201, { swap: swapBody() }) });
  const made = await createSwapApi(h.client).create(TEAM, { offeredShiftId: 's1', requestedShiftId: 's2' }, KEY);
  assert.equal(made.status, 'pending');
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/swaps`);
  assert.deepEqual(h.calls[0]?.body, { offeredShiftId: 's1', requestedShiftId: 's2' });
  assert.equal(h.calls[0]?.headers['idempotency-key'], KEY);
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('a retried request is sent with the SAME key, also when it is replayed after a token refresh', async () => {
  let first = true;
  const h = makeHarness({
    handler: (call) => {
      if (call.path === '/auth/refresh') return json(200, { session: { accessToken: 'fresh', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', refreshToken: 'r2' } });
      if (first) {
        first = false;
        return json(401, { error: { code: 'unauthenticated', message: 'x', requestId: 'r' } });
      }
      return json(200, { swap: swapBody() });
    },
  });
  await createSwapApi(h.client).create(TEAM, { offeredShiftId: 's1', requestedShiftId: 's2' }, KEY);
  const posts = h.calls.filter((c) => c.path === `/teams/${TEAM}/swaps`);
  assert.equal(posts.length, 2, 'the request was replayed once with the new token');
  assert.deepEqual(posts.map((c) => c.headers['idempotency-key']), [KEY, KEY]);
  assert.deepEqual(posts.map((c) => c.authorization), ['Bearer old', 'Bearer fresh']);
});

test('a caller header can never replace the access token', async () => {
  const h = makeHarness({ handler: () => json(200, { swaps: [] }) });
  await h.client.request(`/teams/${TEAM}/swaps`, { headers: { Authorization: 'Bearer stolen', 'X-Test': '1' } });
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
  assert.equal(h.calls[0]?.headers['x-test'], '1');
});

test('TEST 12: offline, the request is refused at once, nothing is sent, and nothing is sent later when the connection returns', async () => {
  let online = false;
  const h = makeHarness({ handler: () => json(201, { swap: swapBody() }), online: () => online });
  await assert.rejects(createSwapApi(h.client).create(TEAM, { offeredShiftId: 's1', requestedShiftId: 's2' }, KEY), (e) => e instanceof OfflineError);
  online = true;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.length, 0, 'no request reached the server, then or later');
});

test('list, get, cancel and decide: the right paths; the team and swap IDs cannot change the path', async () => {
  const h = makeHarness({ handler: (call) => (call.path.endsWith('/swaps') ? json(200, { swaps: [swapBody()] }) : json(200, { swap: swapBody() })) });
  const api = createSwapApi(h.client);
  assert.equal((await api.list(TEAM)).length, 1);
  await api.get(TEAM, 's');
  await api.cancel(TEAM, 's');
  await api.decide(TEAM, 's', 'approve');
  await api.decide(TEAM, 's', 'reject');
  await api.get(TEAM, '../members');
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.path.replace(TEAM, '<team>')}`), [
    'GET /teams/<team>/swaps',
    'GET /teams/<team>/swaps/s',
    'POST /teams/<team>/swaps/s/cancel',
    'POST /teams/<team>/swaps/s/approve',
    'POST /teams/<team>/swaps/s/reject',
    'GET /teams/<team>/swaps/..%2Fmembers',
  ]);
  assert.ok(h.calls.every((c) => c.body === undefined || c.method === 'POST'));
});

test('answers that cannot be read throw invalid_response: a bad status, time, person, shift, flag, or half a list', () => {
  const bad: unknown[] = [
    null,
    {},
    { swap: swapBody({ status: 'approved-ish' }) },
    { swap: swapBody({ createdAt: 5 }) },
    { swap: swapBody({ requester: { id: 1 } }) },
    { swap: swapBody({ offered: { shiftId: 's', title: 'x', area: null, startsAt: 'later', endsAt: '2031-03-04T16:00:00.000Z' } }) },
    { swap: swapBody({ canDecide: 'yes' }) },
    { swap: swapBody({ decidedAt: 7 }) },
  ];
  for (const body of bad) assert.throws(() => parseSwapResponse(body), (e) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(body));
  assert.throws(() => parseSwapList({ swaps: [swapBody(), { id: 'x' }] }), (e) => e instanceof ApiError && e.code === 'invalid_response');
  assert.throws(() => parseSwapList({}), (e) => e instanceof ApiError);
  assert.equal(swapsKey('u1', 't1')[1], 'u1');
  assert.notDeepEqual(swapsKey('u1', 't1'), swapsKey('u2', 't1'));
});

test('text: the card, the detail, the review lines and the headers by state, on the team clock', () => {
  const s = swap();
  assert.equal(swapLabel(s), 'Morning service → Evening service');
  assert.equal(swapDetail(s, LAGOS), 'Amara ↔ Daniel · Tue 4 Mar');
  assert.equal(shiftWhen(s.offered, LAGOS), 'Tue 4 Mar · 09:00 – 17:00');
  assert.equal(swapReviewDetail(s, LAGOS), 'Tue 4 Mar\n09:00–17:00 ↔ 17:00–22:00');
  const nextDay = swap({ requested: { ...swapBody().requested, startsAt: '2031-03-05T16:00:00.000Z', endsAt: '2031-03-05T21:00:00.000Z' } });
  assert.equal(swapReviewDetail(nextDay, LAGOS), 'Tue 4 Mar 09:00–17:00\n↔ Wed 5 Mar 17:00–22:00');
  assert.equal(shiftOptionLabel({ title: 'Evening service', startsAt: s.requested.startsAt, endsAt: s.requested.endsAt, assignee: { name: 'Daniel Mensah' } }, LAGOS, true), 'Daniel Mensah · Tue 4 Mar · 17:00 – 22:00 · Evening service');
  assert.equal(shiftOptionLabel({ title: 'Morning service', startsAt: s.offered.startsAt, endsAt: s.offered.endsAt, assignee: null }, LAGOS, false), 'Tue 4 Mar · 09:00 – 17:00 · Morning service');
  assert.deepEqual(swapHeader({ status: 'pending', canDecide: true }), { title: 'Review swap', subtitle: 'Manager / Owner' });
  assert.deepEqual(swapHeader({ status: 'pending', canDecide: false }), { title: 'Request sent', subtitle: 'Waiting for manager approval.' });
  assert.equal(swapHeader({ status: 'approved', canDecide: false }).title, 'Swap approved');
  assert.equal(swapHeader({ status: 'rejected', canDecide: true }).title, 'Swap not approved');
  assert.equal(swapHeader({ status: 'cancelled', canDecide: false }).title, 'Request cancelled');
});

test('the guess: built from the two shifts, grants no action, and cannot exist without a teammate on the other side', () => {
  const mine = shift('s1', 'Morning service', { id: 'u1', name: 'Amara Okafor' }, '2031-03-04T08:00:00.000Z', '2031-03-04T16:00:00.000Z');
  const theirs = shift('s2', 'Evening service', { id: 'u2', name: 'Daniel Mensah' }, '2031-03-04T16:00:00.000Z', '2031-03-04T21:00:00.000Z');
  const guess = optimisticSwap({ key: KEY, me: { id: 'u1', name: 'Amara Okafor' }, offered: mine, requested: theirs, now: new Date('2031-03-01T00:00:00.000Z') });
  assert.ok(guess);
  assert.equal(guess.status, 'pending');
  assert.equal(guess.counterparty.name, 'Daniel Mensah');
  assert.deepEqual([guess.mine, guess.canCancel, guess.canDecide], [true, false, false], 'only the server\'s answer grants an action');
  assert.equal(guess.id, `optimistic-${KEY}`);
  assert.equal(optimisticSwap({ key: KEY, me: { id: 'u1', name: 'A' }, offered: mine, requested: { ...theirs, assignee: null }, now: new Date() }), null);
});

test('list helpers: the guess goes on top, is replaced by the answer (never duplicated), and a decision updates its row in place', () => {
  const a = swap({ id: 'a', createdAt: '2031-03-01T10:00:00.000Z' });
  const b = swap({ id: 'b', createdAt: '2031-03-02T10:00:00.000Z' });
  const guess = swap({ id: 'optimistic-k' });
  assert.deepEqual(withOptimisticSwap([a, b], guess).map((s) => s.id), ['optimistic-k', 'a', 'b']);
  assert.deepEqual(withOptimisticSwap(undefined, guess).map((s) => s.id), ['optimistic-k']);
  const answer = swap({ id: 'real' });
  assert.deepEqual(replaceSwap([guess, a], 'optimistic-k', answer).map((s) => s.id), ['real', 'a']);
  assert.deepEqual(replaceSwap([answer, a], 'optimistic-k', answer).map((s) => s.id), ['real', 'a'], 'already replaced by a refetch: not shown twice');
  const approved = swap({ id: 'a', status: 'approved' });
  assert.equal(updateSwap([a, b], approved)?.[0]?.status, 'approved');
  assert.equal(updateSwap(undefined, approved), undefined);
});

test('order: waiting requests the viewer may decide first, then other waiting ones, then finished ones; each newest first', () => {
  const list = [
    swap({ id: 'done', status: 'approved', canDecide: false, createdAt: '2031-03-09T00:00:00.000Z' }),
    swap({ id: 'mine', status: 'pending', canDecide: false, createdAt: '2031-03-02T00:00:00.000Z' }),
    swap({ id: 'review-old', status: 'pending', canDecide: true, createdAt: '2031-03-01T00:00:00.000Z' }),
    swap({ id: 'review-new', status: 'pending', canDecide: true, createdAt: '2031-03-03T00:00:00.000Z' }),
  ];
  assert.deepEqual(orderSwaps(list).map((s) => s.id), ['review-new', 'review-old', 'mine', 'done']);
});

test('maySendSwap: offline is refused (not queued), a request already on its way is not sent twice', () => {
  assert.equal(maySendSwap({ online: true, sending: false }), 'yes');
  assert.equal(maySendSwap({ online: false, sending: false }), 'offline');
  assert.equal(maySendSwap({ online: true, sending: true }), 'busy');
  assert.equal(maySendSwap({ online: false, sending: true }), 'busy');
});

test('failures: every server answer has its own words; the session and account cases show nothing', () => {
  const api = (status: number, code: string, details?: unknown, retry: number | null = null) => new ApiError(status, code, 'x', 'req-1', details, retry);
  const msg = (e: unknown) => {
    const f = describeSwapFailure(e);
    return f && 'message' in f ? f.message : f?.kind;
  };
  assert.equal(msg(api(409, 'swap_limit_reached')), swapFailureCopy.limit);
  assert.equal(msg(api(409, 'swap_not_pending')), swapFailureCopy.notPending);
  assert.equal(msg(api(409, 'swap_not_possible', [{ path: 'swap', code: 'would_double_book' }])), swapFailureCopy.wouldDoubleBook);
  assert.equal(msg(api(409, 'swap_not_possible', [{ path: 'swap', code: 'already_in_swap' }])), swapFailureCopy.alreadyInSwap);
  assert.equal(msg(api(409, 'swap_not_possible', [{ path: 'swap', code: 'shift_changed' }])), swapFailureCopy.changed);
  assert.equal(msg(api(400, 'validation_failed', [{ path: 'offeredShiftId', code: 'not_yours' }])), swapFailureCopy.notYours);
  assert.equal(msg(api(400, 'validation_failed', [{ path: 'requestedShiftId', code: 'not_swappable' }])), swapFailureCopy.notSwappable);
  assert.equal(msg(api(400, 'validation_failed', [{ path: 'offeredShiftId', code: 'in_past' }])), swapFailureCopy.inPast);
  assert.equal(msg(api(403, 'forbidden')), swapFailureCopy.forbidden);
  assert.equal(msg(api(404, 'not_found')), 'gone');
  assert.equal(msg(api(429, 'rate_limited', undefined, 1800)), bannerCopy.rateLimited('in 30 minutes'));
  assert.equal(msg(new OfflineError()), 'offline');
  assert.deepEqual(describeSwapFailure(api(503, 'service_unavailable')), { kind: 'generic', reference: 'req-1' });
  assert.deepEqual(describeSwapFailure(api(400, 'validation_failed', [{ path: 'x', code: 'y' }])), { kind: 'generic', reference: 'req-1' });
  for (const e of [new StaleAccountError(), new SessionEndedError('refresh_rejected'), new NotSignedInError()]) assert.equal(describeSwapFailure(e), null);
});

// ---- the optimistic update with rollback, with the real TanStack core (app-state.md tests 1, 2, 12 and 14) ----

function setup() {
  const client = new QueryClient();
  const key = swapsKey('u1', TEAM);
  const existing = swap({ id: 'existing' });
  client.setQueryData<Swap[]>(key, [existing]);
  const mine = shift('s1', 'Morning service', { id: 'u1', name: 'Amara Okafor' }, '2031-03-04T08:00:00.000Z', '2031-03-04T16:00:00.000Z');
  const theirs = shift('s2', 'Evening service', { id: 'u2', name: 'Daniel Mensah' }, '2031-03-04T16:00:00.000Z', '2031-03-04T21:00:00.000Z');
  const input: CreateSwapInput = { offered: mine, requested: theirs, key: KEY, me: { id: 'u1', name: 'Amara Okafor' } };
  return { client, key, existing, input };
}
const ids = (client: QueryClient, key: readonly unknown[]) => (client.getQueryData<Swap[]>(key) ?? []).map((s) => s.id);
const tick = () => new Promise((r) => setTimeout(r, 5));

test('TEST 1: "Swap requested" shows at once (the guess is on top while the server has not answered), then the server\'s answer replaces it', async () => {
  const { client, key, input } = setup();
  const wait = deferred<Swap>();
  const calls: unknown[] = [];
  const options = createSwapMutationOptions(client, 'u1', TEAM, () => ({ create: async (_t, body, k) => (calls.push([body, k]), wait.promise) }));
  const observer = new MutationObserver(client, options);
  const done = observer.mutate(input);
  await tick();
  assert.deepEqual(ids(client, key), [`optimistic-${KEY}`, 'existing'], 'the guess is shown before any answer');
  assert.equal(observer.getCurrentResult().isPending, true);
  assert.deepEqual(calls, [[{ offeredShiftId: 's1', requestedShiftId: 's2' }, KEY]]);
  wait.resolve(swap({ id: 'real' }));
  await done;
  assert.deepEqual(ids(client, key), ['real', 'existing'], 'the guess is replaced, never shown twice');
});

test('TEST 1 (error): a server error puts the list back exactly as it was', async () => {
  const { client, key, existing, input } = setup();
  const options = createSwapMutationOptions(client, 'u1', TEAM, () => ({ create: async () => Promise.reject(new ApiError(500, 'internal_error', 'x', 'r')) }));
  const observer = new MutationObserver(client, options);
  await observer.mutate(input).catch(() => {});
  assert.equal(observer.getCurrentResult().isError, true);
  assert.deepEqual(client.getQueryData<Swap[]>(key), [existing]);
});

test('TEST 1 (error, no list before): the guess is removed, not left behind', async () => {
  const client = new QueryClient();
  const key = swapsKey('u1', TEAM);
  const { input } = setup();
  const options = createSwapMutationOptions(client, 'u1', TEAM, () => ({ create: async () => Promise.reject(new ApiError(500, 'internal_error', 'x', 'r')) }));
  await new MutationObserver(client, options).mutate(input).catch(() => {});
  assert.equal(client.getQueryData(key), undefined);
});

test('TEST 12 and 14: offline the mutation runs and fails AT ONCE (it does not pause), is not retried, and nothing is sent when the connection returns', async () => {
  const { client, key, existing, input } = setup();
  let attempts = 0;
  const options = createSwapMutationOptions(client, 'u1', TEAM, () => ({
    create: async () => {
      attempts++;
      throw new OfflineError();
    },
  }));
  onlineManager.setOnline(false);
  try {
    const observer = new MutationObserver(client, options);
    await observer.mutate(input).catch(() => {});
    assert.equal(observer.getCurrentResult().status, 'error', 'failed, not paused');
    assert.equal(observer.getCurrentResult().isPaused, false);
    assert.equal(attempts, 1, 'no retry');
    assert.deepEqual(client.getQueryData<Swap[]>(key), [existing], 'rolled back');
    onlineManager.setOnline(true);
    await tick();
    assert.equal(attempts, 1, 'nothing is sent after reconnecting');
  } finally {
    onlineManager.setOnline(true);
  }
});
