import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { shardFor, shardIntegerFor } from './shard.js';

// Fixed vectors from .agents/rules/data.md. Must match exactly.
const vectors = [
  { teamId: '00000000-0000-4000-8000-000000000001', bytes: '11e594f4', integer: 300258548, shard: 'A' },
  { teamId: '00000000-0000-4000-8000-000000000002', bytes: 'e79acd97', integer: 3885682071, shard: 'B' },
  { teamId: '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b', bytes: '5b9edf31', integer: 1537138481, shard: 'B' },
] as const;

for (const v of vectors) {
  test(`shard vector ${v.teamId}`, () => {
    const first4 = createHash('sha256').update(v.teamId, 'utf8').digest().subarray(0, 4).toString('hex');
    assert.equal(first4, v.bytes);
    assert.equal(shardIntegerFor(v.teamId), v.integer);
    assert.equal(shardFor(v.teamId), v.shard);
  });
}

test('rejects non-canonical team ids', () => {
  assert.throws(() => shardFor('00000000-0000-4000-8000-00000000000A'));
  assert.throws(() => shardFor('not-a-uuid'));
  assert.throws(() => shardFor(''));
});
