import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argon2Hasher, createPasswordService, normalizePassword, passwordLength, type PasswordHasher } from './password.js';
import { createBlocklist } from './blocklist.js';

test('hash is Argon2id at 19 MiB / 2 iterations / parallelism 1, and differs from the password', async () => {
  const pw = 'correct horse battery staple';
  const h = await argon2Hasher.hash(pw);
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.notEqual(h, pw);
  assert.ok(!h.includes(pw));
});

test('correct password verifies, wrong fails, and the same password hashes differently each time (unique salt)', async () => {
  const pw = 'correct horse battery staple';
  const [h1, h2] = [await argon2Hasher.hash(pw), await argon2Hasher.hash(pw)];
  assert.notEqual(h1, h2);
  assert.equal(await argon2Hasher.verify(h1, pw), true);
  assert.equal(await argon2Hasher.verify(h2, pw), true);
  assert.equal(await argon2Hasher.verify(h1, pw + 'x'), false);
});

test('a malformed stored hash fails verification instead of throwing', async () => {
  assert.equal(await argon2Hasher.verify('not-a-hash', 'whatever'), false);
  assert.equal(await argon2Hasher.verify('', 'whatever'), false);
});

test('NFC: the same password typed composed or decomposed is one password', () => {
  const composed = 'café-au-lait-pour-tous';
  const decomposed = 'café-au-lait-pour-tous';
  assert.notEqual(composed, decomposed);
  assert.equal(normalizePassword(composed), normalizePassword(decomposed));
});

test('length counts Unicode code points, not UTF-16 units (NIST SP 800-63B-4 3.1.1.2)', () => {
  assert.equal(passwordLength('a'.repeat(15)), 15);
  assert.equal(passwordLength('😀'.repeat(15)), 15, '15 emoji are 15 characters, though 30 UTF-16 units');
  assert.equal('😀'.repeat(15).length, 30);
  assert.equal(passwordLength(''), 0);
  assert.equal(passwordLength(normalizePassword('é')), 1, 'after NFC, e + combining acute is one code point');
});

test('verifyAgainst(null) runs exactly one verification against a dummy hash and is always false', async () => {
  let verifies = 0;
  let hashes = 0;
  const spy: PasswordHasher = {
    hash: async (p) => (hashes++, argon2Hasher.hash(p)),
    verify: async (h, p) => (verifies++, argon2Hasher.verify(h, p)),
  };
  const svc = createPasswordService(spy);
  await svc.ready();
  assert.equal(hashes, 1, 'the dummy hash is made once, at startup');

  assert.equal(await svc.verifyAgainst(null, 'anything at all'), false);
  assert.equal(verifies, 1);
  assert.equal(hashes, 1, 'no new hash per unknown-email attempt');

  const real = await svc.hash('a real password value');
  assert.equal(await svc.verifyAgainst(real, 'a real password value'), true);
  assert.equal(await svc.verifyAgainst(real, 'a different password'), false);
  assert.equal(verifies, 3, 'one verification per attempt, whether or not the account exists');
});

test('blocklist: whole-password, case-insensitive, NFC; substrings and extra words do not match', () => {
  const list = createBlocklist(['Password1234567890', 'cafécafecafecafe']);
  assert.equal(list.size, 2);
  assert.equal(list.has('password1234567890'), true);
  assert.equal(list.has('PASSWORD1234567890'), true);
  assert.equal(list.has('cafécafecafecafe'), true, 'decomposed form matches the composed entry');
  assert.equal(list.has('password1234567890!'), false, 'NIST: the entire password is compared, not substrings');
  assert.equal(list.has('my-password1234567890'), false);
  assert.equal(createBlocklist([]).has('anything'), false);
});
