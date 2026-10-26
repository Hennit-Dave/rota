import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LINK_TOKEN_LENGTH, readLinkToken } from './linkToken';

test('a string param is the token, trimmed', () => {
  assert.equal(readLinkToken('abc'), 'abc');
  assert.equal(readLinkToken('  abc  '), 'abc');
});

test('a repeated key (a list) uses the first value', () => {
  assert.equal(readLinkToken(['first', 'second']), 'first');
});

test('nothing, an empty value or a list with nothing in it is "no token"', () => {
  assert.equal(readLinkToken(undefined), null);
  assert.equal(readLinkToken(''), null);
  assert.equal(readLinkToken('   '), null);
  assert.equal(readLinkToken([]), null);
});

test('a value longer than the server accepts cannot be a link we sent', () => {
  assert.equal(readLinkToken('x'.repeat(MAX_LINK_TOKEN_LENGTH)), 'x'.repeat(MAX_LINK_TOKEN_LENGTH));
  assert.equal(readLinkToken('x'.repeat(MAX_LINK_TOKEN_LENGTH + 1)), null);
});
