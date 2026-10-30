import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { teamDetailQueryKey } from '../teams/teamResponses';
import { billingKey, operationKey, type Operation, type OperationStatus } from './billingResponses';
import { operationQueryOptions, refreshAfterSettled } from './operationQuery';

const USER = 'u-1';
const TEAM = 't-1';
const OP = 'op-1';
const op = (status: OperationStatus): Operation => ({ id: OP, kind: 'change', status, plan: 'team', planName: 'Team', seats: 9, amountDisplay: '$50.00', expiresAt: '2031-06-01T12:31:00.000Z' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Regression (found on the emulator, 2026-10-29): the server said `paid` but the screen stayed on "Confirming" and the app asked every 0.6 s. */
test('a settled answer is STORED and asked for once: the status screen shows paid and polling stops', async () => {
  const client = new QueryClient();
  let asked = 0;
  const api = { operation: async () => (asked++, op('paid')) };
  const observer = new QueryObserver(client, operationQueryOptions(client, { api: () => api, userId: USER, teamId: TEAM, operationId: OP }));
  const stop = observer.subscribe(() => {});
  try {
    await wait(300);
    assert.equal(observer.getCurrentResult().data?.status, 'paid', 'the server\'s answer reached the screen');
    assert.equal(asked, 1, 'one request, not a loop');
  } finally {
    stop();
    client.clear();
  }
});

test('REGRESSION: a poll that finds the payment settled stores that answer (the screen leaves "confirming") and does not loop', async () => {
  const client = new QueryClient();
  let status: OperationStatus = 'confirming';
  let asked = 0;
  // A loop would spin forever against an instant fake, so it gives up after 20 questions and the assertions below fail instead of hanging.
  const api = {
    operation: async () => {
      if (++asked > 20) throw new Error('asked more than 20 times: the screen is looping');
      return op(status);
    },
  };
  const observer = new QueryObserver(client, operationQueryOptions(client, { api: () => api, userId: USER, teamId: TEAM, operationId: OP }));
  const stop = observer.subscribe(() => {});
  try {
    await wait(150);
    assert.equal(observer.getCurrentResult().data?.status, 'confirming', 'the first answer');
    assert.equal(asked, 1);

    // The webhook has been processed. The next poll tick (refetchInterval does exactly this; Node counts as a server, where TanStack never runs the timer) finds it paid.
    status = 'paid';
    await observer.refetch();
    await wait(300);
    assert.equal(observer.getCurrentResult().data?.status, 'paid', 'the server\'s newer answer reached the screen');
    assert.ok(asked <= 3, `asked ${asked} times: it must not loop`);
  } finally {
    stop();
    client.clear();
  }
});

test('after a settled payment the billing overview and the team detail are refreshed, and the payment\'s own query and any quote are left alone', () => {
  const client = new QueryClient();
  const quoteKey = [...billingKey(USER, TEAM), 'quote', 'team', 9] as const;
  for (const key of [billingKey(USER, TEAM), teamDetailQueryKey(USER, TEAM), operationKey(USER, TEAM, OP), quoteKey]) client.setQueryData(key, { x: 1 });
  refreshAfterSettled(client, USER, TEAM);
  assert.equal(client.getQueryState(billingKey(USER, TEAM))?.isInvalidated, true, 'the overview will be asked again');
  assert.equal(client.getQueryState(teamDetailQueryKey(USER, TEAM))?.isInvalidated, true, 'and so will the team detail');
  assert.equal(client.getQueryState(operationKey(USER, TEAM, OP))?.isInvalidated, false, 'but the payment status is not thrown away');
  assert.equal(client.getQueryState(quoteKey)?.isInvalidated, false);
  client.clear();
});
