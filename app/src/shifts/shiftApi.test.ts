import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createShiftApi } from './shiftApi';

const TEAM = '11111111-1111-4111-8111-111111111111';
const SHIFT = '22222222-2222-4222-8222-222222222222';
const shiftBody = {
  id: SHIFT,
  title: 'Morning service',
  area: null,
  startsAt: '2031-03-04T08:00:00.000Z',
  endsAt: '2031-03-04T16:00:00.000Z',
  breakMinutes: null,
  note: null,
  assignee: { id: 'u1', name: 'Amara Okafor' },
  status: 'scheduled',
  createdAt: '2031-03-01T00:00:00.000Z', // fields the app does not use are ignored
};

test('list: GET with the range and the mine flag in the query, the team in the path, nothing else', async () => {
  const h = makeHarness({ handler: () => json(200, { shifts: [shiftBody] }) });
  const shifts = await createShiftApi(h.client).list(TEAM, { from: '2031-03-03T00:00:00.000Z', to: '2031-03-10T00:00:00.000Z', mine: true });
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0]?.assignee?.name, 'Amara Okafor');
  assert.equal(h.calls[0]?.method, 'GET');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/shifts`);
  assert.equal(h.calls[0]?.search, '?from=2031-03-03T00%3A00%3A00.000Z&to=2031-03-10T00%3A00%3A00.000Z&mine=true');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('create: POST sends only what the person typed; no user, role, team or status is ever sent', async () => {
  const h = makeHarness({ handler: () => json(201, { shift: shiftBody }) });
  await createShiftApi(h.client).create(TEAM, { title: 'Morning service', startsAt: shiftBody.startsAt, endsAt: shiftBody.endsAt, assignedUserId: null });
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/shifts`);
  assert.deepEqual(h.calls[0]?.body, { title: 'Morning service', startsAt: shiftBody.startsAt, endsAt: shiftBody.endsAt, assignedUserId: null });
});

test('update: PATCH carries only the changed fields; null unassigns', async () => {
  const h = makeHarness({ handler: () => json(200, { shift: shiftBody }) });
  await createShiftApi(h.client).update(TEAM, SHIFT, { assignedUserId: null });
  assert.equal(h.calls[0]?.method, 'PATCH');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/shifts/${SHIFT}`);
  assert.deepEqual(h.calls[0]?.body, { assignedUserId: null });
});

test('get and remove: GET one shift, DELETE with no body and a 204 answer', async () => {
  const h = makeHarness({
    handler: (call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, { shift: shiftBody })),
  });
  const api = createShiftApi(h.client);
  assert.equal((await api.get(TEAM, SHIFT)).id, SHIFT);
  await api.remove(TEAM, SHIFT);
  assert.deepEqual(
    h.calls.map((c) => [c.method, c.path]),
    [
      ['GET', `/teams/${TEAM}/shifts/${SHIFT}`],
      ['DELETE', `/teams/${TEAM}/shifts/${SHIFT}`],
    ],
  );
});

test('an ID with odd characters cannot change the path', async () => {
  const h = makeHarness({ handler: () => json(200, { shift: shiftBody }) });
  await createShiftApi(h.client).get(TEAM, '../members');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/shifts/..%2Fmembers`);
});

test('a 409 overlap and a 403 reach the screen as ApiError with the server code and request ID', async () => {
  const h = makeHarness({ handler: () => json(409, { error: { code: 'shift_overlap', message: 'x', requestId: 'req-5' } }, { 'X-Request-Id': 'req-5' }) });
  await assert.rejects(createShiftApi(h.client).create(TEAM, { title: 'x', startsAt: shiftBody.startsAt, endsAt: shiftBody.endsAt }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'shift_overlap');
    assert.equal(e.requestId, 'req-5');
    return true;
  });
});

test('answers that cannot be read throw invalid_response: a missing shift, a bad time, a bad status, half a list', async () => {
  for (const body of [
    {},
    { shift: { ...shiftBody, startsAt: 'yesterday' } },
    { shift: { ...shiftBody, status: 'draft' } },
    { shift: { ...shiftBody, breakMinutes: 1.5 } },
    { shift: { ...shiftBody, assignee: { id: 1 } } },
    { shift: { ...shiftBody, title: undefined } },
  ]) {
    const h = makeHarness({ handler: () => json(200, body) });
    await assert.rejects(createShiftApi(h.client).get(TEAM, SHIFT), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(body));
  }
  const h = makeHarness({ handler: () => json(200, { shifts: [shiftBody, { id: 'x' }] }) });
  await assert.rejects(createShiftApi(h.client).list(TEAM, { from: 'a', to: 'b', mine: false }), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
});
