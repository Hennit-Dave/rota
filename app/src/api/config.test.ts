import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseApiBaseUrl } from './config';

test('https is accepted and a trailing slash is removed', () => {
  assert.equal(parseApiBaseUrl('https://api.example.com/', false), 'https://api.example.com');
  assert.equal(parseApiBaseUrl('https://api.example.com/v1/', false), 'https://api.example.com/v1');
});

test('http is accepted only for the local API in a development build', () => {
  assert.equal(parseApiBaseUrl('http://10.0.2.2:3000', true), 'http://10.0.2.2:3000');
  assert.throws(() => parseApiBaseUrl('http://10.0.2.2:3000', false), ConfigError);
  assert.throws(() => parseApiBaseUrl('http://api.example.com', true), ConfigError);
});

test('missing, malformed, or credential-bearing values are refused', () => {
  assert.throws(() => parseApiBaseUrl(undefined, true), ConfigError);
  assert.throws(() => parseApiBaseUrl('', true), ConfigError);
  assert.throws(() => parseApiBaseUrl('not a url', true), ConfigError);
  assert.throws(() => parseApiBaseUrl('https://user:pass@api.example.com', false), ConfigError);
  assert.throws(() => parseApiBaseUrl('https://api.example.com/?token=1', false), ConfigError);
});
