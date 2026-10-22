import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentLogger } from '../api/errors';
import { AccountEpoch } from './epoch';
import { createSignOutLocal, type SignOutSteps } from './signOut';
import { createSessionActions } from './session';
import { SessionEndedError, ApiError } from '../api/errors';
import type { SignOutNotice } from './types';

function recorder() {
  const epoch = new AccountEpoch();
  const order: string[] = [];
  const epochSeen: number[] = [];
  const notices: SignOutNotice[] = [];
  const steps: SignOutSteps = {
    clearQueryCaches: () => {
      order.push('clearQueryCaches');
      epochSeen.push(epoch.current);
    },
    clearPersistedCache: () => {
      order.push('clearPersistedCache');
    },
    resetClientState: (notice) => {
      order.push('resetClientState');
      notices.push(notice);
    },
    clearTokens: async () => {
      order.push('clearTokens');
    },
  };
  return { epoch, order, epochSeen, notices, steps };
}

test('app-state order: epoch first, then caches, persisted cache, client state, tokens', async () => {
  const r = recorder();
  const signOut = createSignOutLocal({ epoch: r.epoch, steps: r.steps, logger: silentLogger });
  await signOut('session_ended');
  assert.deepEqual(r.order, ['clearQueryCaches', 'clearPersistedCache', 'resetClientState', 'clearTokens']);
  assert.equal(r.epochSeen[0], 1, 'the epoch was already bumped when the first step ran');
  assert.deepEqual(r.notices, ['session_ended']);
});

test('a failing step does not stop the later ones: the tokens are always deleted', async () => {
  const r = recorder();
  const warnings: string[] = [];
  r.steps.clearQueryCaches = () => {
    throw new Error('boom');
  };
  r.steps.clearPersistedCache = async () => {
    throw new Error('boom');
  };
  const signOut = createSignOutLocal({ epoch: r.epoch, steps: r.steps, logger: { warn: (e) => warnings.push(e) } });
  await signOut();
  assert.deepEqual(r.order, ['resetClientState', 'clearTokens']);
  assert.equal(warnings.length, 2);
});

test('simultaneous sign-outs share one run', async () => {
  const r = recorder();
  const signOut = createSignOutLocal({ epoch: r.epoch, steps: r.steps, logger: silentLogger });
  await Promise.all([signOut('session_ended'), signOut('revoke_unconfirmed'), signOut()]);
  assert.equal(r.order.filter((s) => s === 'clearTokens').length, 1);
  assert.equal(r.epoch.current, 1);
});

test('a later sign-out (next session) runs again', async () => {
  const r = recorder();
  const signOut = createSignOutLocal({ epoch: r.epoch, steps: r.steps, logger: silentLogger });
  await signOut();
  await signOut();
  assert.equal(r.epoch.current, 2);
});

function logoutHarness(post: () => Promise<unknown>, online = true) {
  const calls: SignOutNotice[] = [];
  const actions = createSessionActions({
    client: { post: post as never },
    isOnline: () => online,
    signOutLocal: async (notice = 'none') => {
      calls.push(notice);
    },
  });
  return { actions, calls };
}

test('app-state test 15: online logout asks the server first, then signs out locally', async () => {
  const order: string[] = [];
  const { actions, calls } = logoutHarness(async () => {
    order.push('post');
  });
  const result = await actions.logout();
  assert.deepEqual(result, { serverConfirmed: true });
  assert.deepEqual(order, ['post']);
  assert.deepEqual(calls, ['none']);
});

test('app-state test 15: offline logout signs out at once and says the revoke was not confirmed', async () => {
  let posted = false;
  const { actions, calls } = logoutHarness(async () => {
    posted = true;
  }, false);
  assert.deepEqual(await actions.logout(), { serverConfirmed: false });
  assert.equal(posted, false);
  assert.deepEqual(calls, ['revoke_unconfirmed']);
});

test('a failed revoke still signs out locally and says so', async () => {
  const { actions, calls } = logoutHarness(async () => {
    throw new ApiError(500, 'internal_error', 'x', null);
  });
  assert.deepEqual(await actions.logout(), { serverConfirmed: false });
  assert.deepEqual(calls, ['revoke_unconfirmed']);
});

test('a session the server already called invalid skips the revoke and does not sign out twice', async () => {
  const { actions, calls } = logoutHarness(async () => {
    throw new SessionEndedError('refresh_rejected');
  });
  assert.deepEqual(await actions.logout(), { serverConfirmed: true });
  assert.deepEqual(calls, [], 'the refresh path already did the local sign-out and set the notice');
});
