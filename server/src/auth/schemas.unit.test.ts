import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { z } from 'zod';
import { toErrorDetails } from '../http/validate.js';
import { createBlocklist } from './blocklist.js';
import { loadAuthConfig } from './config.js';
import { createAuthSchemas } from './schemas.js';

const config = loadAuthConfig({});
const blocklist = createBlocklist(['password1234567890', '1234567890123456']);
const { register, login } = createAuthSchemas(config, blocklist);
const good = { name: 'Amara Okafor', email: 'amara@example.com', password: 'a-long-enough-pass' };

const details = (input: unknown, schema: z.ZodType = register) => {
  const r = schema.safeParse(input);
  assert.ok(!r.success, 'expected validation to fail');
  return toErrorDetails(r.error);
};

test('register accepts a valid body and normalises email, name and password', () => {
  const r = register.safeParse({ name: '  Amara  ', email: '  Amara@Example.COM ', password: 'café-au-lait-pour-tous' });
  assert.ok(r.success);
  assert.deepEqual(
    { name: r.data.name, email: r.data.email, password: r.data.password },
    { name: 'Amara', email: 'amara@example.com', password: 'café-au-lait-pour-tous' },
  );
});

test('password length: 14 code points is too short, 15 passes, 128 passes, 129 is too long', () => {
  assert.deepEqual(details({ ...good, password: 'a'.repeat(14) }), [{ path: 'password', code: 'too_short', min: 15 }]);
  assert.ok(register.safeParse({ ...good, password: 'a'.repeat(15) }).success);
  assert.ok(register.safeParse({ ...good, password: 'a'.repeat(128) }).success);
  assert.deepEqual(details({ ...good, password: 'a'.repeat(129) }), [{ path: 'password', code: 'too_long', max: 128 }]);
});

test('password length counts code points: 15 emoji pass, 14 emoji fail', () => {
  assert.ok(register.safeParse({ ...good, password: '😀'.repeat(15) }).success);
  assert.deepEqual(details({ ...good, password: '😀'.repeat(14) }), [{ path: 'password', code: 'too_short', min: 15 }]);
});

test('no composition rules: all-lowercase and all-digit passwords of enough length are fine', () => {
  assert.ok(register.safeParse({ ...good, password: 'abcdefghijklmnopq' }).success);
  assert.ok(register.safeParse({ ...good, password: '918273645019283' }).success);
  assert.ok(register.safeParse({ ...good, password: 'with spaces in it ok' }).success);
});

test('a blocklisted password is rejected with the distinct code password_common, on the password path', () => {
  assert.deepEqual(details({ ...good, password: 'Password1234567890' }), [{ path: 'password', code: 'password_common' }]);
  assert.deepEqual(details({ ...good, password: '1234567890123456' }), [{ path: 'password', code: 'password_common' }]);
  assert.ok(register.safeParse({ ...good, password: 'password1234567890-and-more' }).success, 'whole password only');
});

test('a too-short blocklisted-looking password reports length, not the blocklist (one clear problem)', () => {
  assert.deepEqual(details({ ...good, password: 'password' }), [{ path: 'password', code: 'too_short', min: 15 }]);
});

test('email and name rules; unknown keys are rejected', () => {
  assert.deepEqual(details({ ...good, email: 'not-an-email' }), [{ path: 'email', code: 'invalid_email' }]);
  assert.deepEqual(details({ ...good, email: `${'a'.repeat(250)}@x.co` })[0]?.path, 'email');
  assert.deepEqual(details({ ...good, name: '   ' }), [{ path: 'name', code: 'too_short', min: 1 }]);
  assert.deepEqual(details({ ...good, name: 'n'.repeat(101) }), [{ path: 'name', code: 'too_long', max: 100 }]);
  assert.ok(register.safeParse({ ...good, name: 'n'.repeat(100) }).success);
  assert.deepEqual(details({ ...good, role: 'owner' }), [{ path: '', code: 'unrecognized_key' }]);
  assert.deepEqual(details({}).map((d) => d.path).sort(), ['email', 'name', 'password']);
});

test('login applies no password policy: any non-empty password up to the maximum is accepted for checking', () => {
  assert.ok(login.safeParse({ email: 'a@b.co', password: 'x' }).success, 'short old passwords are checked, not rejected as "too short"');
  assert.ok(login.safeParse({ email: 'a@b.co', password: 'password1234567890' }).success, 'a blocklisted password is not a login error');
  assert.deepEqual(details({ email: 'a@b.co', password: '' }, login), [{ path: 'password', code: 'too_short', min: 1 }]);
  assert.deepEqual(details({ email: 'a@b.co', password: 'x'.repeat(129) }, login), [{ path: 'password', code: 'too_long', max: 128 }]);
  assert.deepEqual(details({ email: 'a@b.co', password: 'x', extra: 1 }, login), [{ path: '', code: 'unrecognized_key' }]);
});

test('error details never contain the submitted password', () => {
  const secret = 'Password1234567890';
  assert.ok(!JSON.stringify(details({ ...good, password: secret })).toLowerCase().includes('password1234567890'));
});
