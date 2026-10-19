import { defineConfig } from 'prisma/config';

// Migrations always use the DIRECT (unpooled) URL: Prisma's migration engine does not work through
// PgBouncer (data.md). Pick the shard with SHARD=a, SHARD=b, SHARD=test_a, or SHARD=test_b.
const shard = process.env.SHARD;
if (shard !== 'a' && shard !== 'b' && shard !== 'test_a' && shard !== 'test_b') {
  throw new Error('Set SHARD to "a", "b", "test_a", or "test_b" before running a Prisma command.');
}

const VAR_MAP: Record<string, string> = {
  a: 'SHARD_A_DIRECT_URL',
  b: 'SHARD_B_DIRECT_URL',
  test_a: 'TEST_SHARD_A_DIRECT_URL',
  test_b: 'TEST_SHARD_B_DIRECT_URL',
};

const varName = VAR_MAP[shard];
const url = process.env[varName];
if (!url) {
  throw new Error(`${varName} is not set.`);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
