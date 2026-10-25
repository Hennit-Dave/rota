import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_INVITE_TOKEN_LENGTH, readInviteToken } from './inviteLink';

const token = '3278f64b-0284-4626-bd0c-1ed21ca65413.Zm9vYmFy';

test('a string param is the token, trimmed', () => {
  assert.equal(readInviteToken(token), token);
  assert.equal(readInviteToken(`  ${token}  `), token);
});

test('a repeated param uses the first value; a missing, empty or blank one is no token', () => {
  assert.equal(readInviteToken([token, 'other']), token);
  assert.equal(readInviteToken(undefined), null);
  assert.equal(readInviteToken(''), null);
  assert.equal(readInviteToken('   '), null);
  assert.equal(readInviteToken([]), null);
});

test('a value longer than the server accepts cannot be one of our links', () => {
  assert.equal(readInviteToken('a'.repeat(MAX_INVITE_TOKEN_LENGTH)), 'a'.repeat(MAX_INVITE_TOKEN_LENGTH));
  assert.equal(readInviteToken('a'.repeat(MAX_INVITE_TOKEN_LENGTH + 1)), null);
});
