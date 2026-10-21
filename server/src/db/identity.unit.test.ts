import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityDb } from './identity.js';

test('identityDb returns shard A\'s primary and never B', () => {
  const A = { primary: { name: 'A-primary' } };
  const B = { primary: { name: 'B-primary' } };
  assert.equal(identityDb({ A, B } as never), A.primary);
  assert.notEqual(identityDb({ A, B } as never), B.primary);
});
