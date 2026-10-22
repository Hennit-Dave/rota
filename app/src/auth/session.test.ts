import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, OfflineError, SessionEndedError } from '../api/errors';
import { createSessionActions } from './session';
import type { SignOutNotice } from './types';

function setup(options: { online?: boolean; post: (path: string) => Promise<unknown> }) {
  const order: string[] = [];
  const notices: SignOutNotice[] = [];
  const actions = createSessionActions({
    client: {
      post: (async (path: string) => {
        order.push(`post ${path}`);
        return options.post(path);
      }) as never,
    },
    isOnline: () => options.online !== false,
    signOutLocal: async (notice = 'none') => {
      order.push('signOutLocal');
      notices.push(notice);
    },
  });
  return { actions, order, notices };
}

test('logout all: asks the server first, then does the local sign-out with no notice', async () => {
  const { actions, order, notices } = setup({ post: async () => undefined });
  await actions.logoutAll();
  assert.deepEqual(order, ['post /auth/logout-all', 'signOutLocal']);
  assert.deepEqual(notices, ['none']);
});

test('logout all while offline: nothing is sent and the user stays signed in (it must not pretend every device is ended)', async () => {
  const { actions, order, notices } = setup({ online: false, post: async () => undefined });
  await assert.rejects(actions.logoutAll(), OfflineError);
  assert.deepEqual(order, []);
  assert.deepEqual(notices, []);
});

test('logout all when the server fails: the error reaches the screen and the user stays signed in', async () => {
  const { actions, order, notices } = setup({
    post: async () => {
      throw new ApiError(500, 'internal_error', 'x', 'req-1');
    },
  });
  await assert.rejects(actions.logoutAll(), (error: unknown) => error instanceof ApiError && error.status === 500);
  assert.deepEqual(order, ['post /auth/logout-all']);
  assert.deepEqual(notices, []);
});

test('logout all when the session had already ended: no second local sign-out', async () => {
  const { actions, order } = setup({
    post: async () => {
      throw new SessionEndedError('refresh_rejected');
    },
  });
  await actions.logoutAll();
  assert.deepEqual(order, ['post /auth/logout-all']);
});

test('logout (this device) is unchanged: online asks the server, then signs out; offline signs out at once with the unconfirmed notice', async () => {
  const online = setup({ post: async () => undefined });
  assert.deepEqual(await online.actions.logout(), { serverConfirmed: true });
  assert.deepEqual(online.order, ['post /auth/logout', 'signOutLocal']);
  assert.deepEqual(online.notices, ['none']);

  const offline = setup({ online: false, post: async () => undefined });
  assert.deepEqual(await offline.actions.logout(), { serverConfirmed: false });
  assert.deepEqual(offline.order, ['signOutLocal']);
  assert.deepEqual(offline.notices, ['revoke_unconfirmed']);
});
