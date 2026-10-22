import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExpoConfig } from 'expo/config';
import makeConfig from '../app.config';

// app.config.ts is compiled into the Android build, so what it says about links and permissions is worth a test.
const config: ExpoConfig = makeConfig({ config: {} as ExpoConfig, projectRoot: '', staticConfigPath: null, packageJsonPath: null });
const android = config.android!;

test('package name and scheme are the agreed ones', () => {
  assert.equal(android.package, 'design.davebuilds.rota');
  assert.equal(config.scheme, 'rota');
});

test('App Links: https, verified, on the agreed host, and matched as PATH PREFIXES (so /invite/<token> works)', () => {
  const filters = android.intentFilters ?? [];
  assert.equal(filters.length, 1);
  const filter = filters[0]!;
  assert.equal(filter.autoVerify, true);
  assert.equal(filter.action, 'VIEW');
  assert.deepEqual([...(filter.category ?? [])].sort(), ['BROWSABLE', 'DEFAULT']);

  const data = [filter.data ?? []].flat();
  assert.deepEqual(data.map((d) => d.pathPrefix), ['/invite', '/magic', '/reset', '/checkout']);
  for (const d of data) {
    assert.equal(d.scheme, 'https');
    assert.equal(d.host, 'rota.davebuilds.design');
    assert.equal(d.path, undefined, 'an exact "path" would not match /invite/<token>');
    assert.equal(d.pathPattern, undefined);
  }
});

test('permissions the app needs are not blocked, and the unused ones are', () => {
  const blocked = new Set(android.blockedPermissions ?? []);
  for (const needed of [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.ACCESS_WIFI_STATE',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.VIBRATE',
    'android.permission.WAKE_LOCK',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'com.google.android.c2dm.permission.RECEIVE',
  ]) {
    assert.ok(!blocked.has(needed), `${needed} is needed and must not be blocked`);
  }
  for (const unused of ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.USE_BIOMETRIC']) {
    assert.ok(blocked.has(unused), `${unused} should be blocked`);
  }
});

test('sqlite-vec stays off: its prebuilt library is not 16 KB aligned (ADR 0010)', () => {
  const sqlite = (config.plugins ?? []).find((p) => Array.isArray(p) && p[0] === 'expo-sqlite') as [string, Record<string, unknown>] | undefined;
  assert.ok(sqlite, 'expo-sqlite plugin is configured');
  assert.equal(sqlite[1].useSQLCipher, false);
  assert.equal((sqlite[1].android as { withSQLiteVecExtension?: boolean }).withSQLiteVecExtension, false);
});
