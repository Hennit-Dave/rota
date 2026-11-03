import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerThisDevice, unregisterThisDevice, type PermissionStatus, type PushPlatform } from './registration';

function fake(opts: { permission?: PermissionStatus; afterRequest?: PermissionStatus; tokenFails?: boolean; channelFails?: boolean } = {}) {
  const calls: string[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const platform: PushPlatform = {
    async ensureChannel() {
      calls.push('channel');
      if (opts.channelFails) throw new Error('channel');
    },
    async permission() {
      calls.push('permission');
      return opts.permission ?? 'granted';
    },
    async requestPermission() {
      calls.push('request');
      return opts.afterRequest ?? 'granted';
    },
    async getToken() {
      calls.push('token');
      if (opts.tokenFails) throw new Error('ExponentPushToken[secret-should-never-be-logged]: no play services');
      return 'ExponentPushToken[abc]';
    },
  };
  const api = {
    async register(t: string) {
      calls.push('register');
      registered.push(t);
    },
    async unregister(t: string) {
      calls.push('unregister');
      unregistered.push(t);
    },
  };
  const warnings: string[] = [];
  return { platform, api, calls, registered, unregistered, warnings, warn: (e: string) => void warnings.push(e) };
}

test('already allowed: the channel is made first, then the token is registered; the person is not asked again', async () => {
  const f = fake();
  assert.deepEqual(await registerThisDevice(f), { status: 'registered' });
  assert.deepEqual(f.calls, ['channel', 'permission', 'token', 'register']);
  assert.deepEqual(f.registered, ['ExponentPushToken[abc]']);
});

test('not asked yet: the channel exists BEFORE the permission prompt (Android 13 and later), then the token follows the "allow"', async () => {
  const f = fake({ permission: 'undetermined', afterRequest: 'granted' });
  assert.deepEqual(await registerThisDevice(f), { status: 'registered' });
  assert.deepEqual(f.calls, ['channel', 'permission', 'request', 'token', 'register']);
});

test('refused: no token is fetched and nothing is registered', async () => {
  for (const f of [fake({ permission: 'denied' }), fake({ permission: 'undetermined', afterRequest: 'denied' })]) {
    assert.deepEqual(await registerThisDevice(f), { status: 'no_permission' });
    assert.equal(f.calls.includes('token'), false);
    assert.equal(f.registered.length, 0);
  }
});

test('a failure (no Play services, offline, a refused request) is reported without ever carrying the token or the cause', async () => {
  const f = fake({ tokenFails: true });
  assert.deepEqual(await registerThisDevice(f), { status: 'failed' });
  assert.deepEqual(f.warnings, ['push_registration_failed']);
  assert.doesNotMatch(f.warnings.join(' '), /secret|ExponentPushToken/);
  const g = fake({ channelFails: true });
  assert.deepEqual(await registerThisDevice(g), { status: 'failed' });
});

test('sign-out: the phone is unregistered if notifications were allowed; never if they were not; and a failure never throws', async () => {
  const allowed = fake();
  await unregisterThisDevice(allowed);
  assert.deepEqual(allowed.unregistered, ['ExponentPushToken[abc]']);
  const refused = fake({ permission: 'denied' });
  await unregisterThisDevice(refused);
  assert.equal(refused.unregistered.length, 0);
  const broken = fake({ tokenFails: true });
  await assert.doesNotReject(() => unregisterThisDevice(broken));
  assert.deepEqual(broken.warnings, ['push_unregister_failed']);
});
