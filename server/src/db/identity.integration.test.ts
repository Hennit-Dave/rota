import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { createTestShards, type Shards } from './clients.js';
import { identityDb } from './identity.js';
import type { PrismaClient } from '../generated/prisma/client.js';

// The same migrations run on both shards (data.md), so the constraints are checked on BOTH test databases.
let shards: Shards;
const created: Array<[PrismaClient, string]> = [];

before(() => {
  shards = createTestShards({ primaryMax: 2 });
});
afterEach(async () => {
  // Deleting the user cascades to credentials, families and tokens.
  for (const [p, id] of created.splice(0)) await p.user.deleteMany({ where: { id } });
});
after(async () => {
  await shards.A.primary.$disconnect();
  await shards.B.primary.$disconnect();
});

async function makeUser(db: PrismaClient, email = `u-${randomUUID()}@example.com`) {
  const u = await db.user.create({ data: { email, name: 'Test User' } });
  created.push([db, u.id]);
  return u;
}

for (const shard of ['A', 'B'] as const) {
  const db = () => shards[shard].primary;

  test(`shard ${shard}: identity tables, columns and indexes exist with the right types`, async () => {
    const cols = await db().$queryRaw<Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>>`
      SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('users','credentials','refresh_token_families','refresh_tokens')`;
    const col = (t: string, c: string) => cols.find((x) => x.table_name === t && x.column_name === c);
    assert.equal(col('users', 'email')?.data_type, 'text');
    assert.equal(col('users', 'email_verified_at')?.is_nullable, 'YES');
    assert.equal(col('credentials', 'password_hash')?.is_nullable, 'NO');
    assert.equal(col('refresh_tokens', 'token_hash')?.data_type, 'bytea');
    for (const [t, c] of [
      ['users', 'created_at'], ['credentials', 'updated_at'], ['refresh_token_families', 'absolute_expires_at'],
      ['refresh_token_families', 'revoked_at'], ['refresh_tokens', 'idle_expires_at'], ['refresh_tokens', 'used_at'],
    ] as const) {
      assert.equal(col(t, c)?.data_type, 'timestamp with time zone', `${t}.${c} must be timestamptz`);
    }
    const idx = await db().$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(idx.map((i) => i.indexname));
    for (const n of ['users_email_key', 'refresh_tokens_token_hash_key', 'refresh_token_families_user_id_idx', 'refresh_tokens_family_id_idx']) {
      assert.ok(names.has(n), `missing index ${n}`);
    }
  });

  test(`shard ${shard}: a second user with the same email is refused by the database (registration is atomic)`, async () => {
    const u = await makeUser(db());
    await assert.rejects(() => db().user.create({ data: { email: u.email, name: 'Other' } }), (e: { code?: string }) => e.code === 'P2002');
  });

  test(`shard ${shard}: the database is case-sensitive, so the application must lowercase emails`, async () => {
    const base = `Case-${randomUUID()}@Example.com`;
    await makeUser(db(), base.toLowerCase());
    const second = await makeUser(db(), base); // accepted: nothing in the database normalises case
    assert.notEqual(second.email, base.toLowerCase());
  });

  test(`shard ${shard}: refresh_tokens.token_hash is unique and an orphan token is refused`, async () => {
    const u = await makeUser(db());
    const fam = await db().refreshTokenFamily.create({ data: { userId: u.id, absoluteExpiresAt: new Date(Date.now() + 86_400_000) } });
    const hash = randomBytes(32);
    await db().refreshToken.create({ data: { familyId: fam.id, tokenHash: hash, idleExpiresAt: new Date(Date.now() + 3_600_000) } });
    await assert.rejects(
      () => db().refreshToken.create({ data: { familyId: fam.id, tokenHash: hash, idleExpiresAt: new Date() } }),
      (e: { code?: string }) => e.code === 'P2002',
    );
    await assert.rejects(
      () => db().refreshToken.create({ data: { familyId: randomUUID(), tokenHash: randomBytes(32), idleExpiresAt: new Date() } }),
      (e: { code?: string }) => e.code === 'P2003',
    );
  });

  test(`shard ${shard}: deleting a user cascades to credentials, families and tokens`, async () => {
    const u = await makeUser(db());
    await db().credential.create({ data: { userId: u.id, passwordHash: '$argon2id$placeholder' } });
    const fam = await db().refreshTokenFamily.create({ data: { userId: u.id, absoluteExpiresAt: new Date(Date.now() + 86_400_000) } });
    await db().refreshToken.create({ data: { familyId: fam.id, tokenHash: randomBytes(32), idleExpiresAt: new Date(Date.now() + 3_600_000) } });

    await db().user.delete({ where: { id: u.id } });

    assert.equal(await db().credential.count({ where: { userId: u.id } }), 0);
    assert.equal(await db().refreshTokenFamily.count({ where: { userId: u.id } }), 0);
    assert.equal(await db().refreshToken.count({ where: { familyId: fam.id } }), 0);
  });
}

test('identityDb on the test shards is shard A\'s primary', () => {
  assert.equal(identityDb(shards), shards.A.primary);
});
