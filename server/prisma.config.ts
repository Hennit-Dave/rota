import { defineConfig } from 'prisma/config';

// Migrations always use the DIRECT (unpooled) URL: Prisma's migration engine does not work through
// PgBouncer (data.md). Pick the shard with SHARD=a or SHARD=b. There is no default, on purpose.
const shard = process.env.SHARD;
if (shard !== 'a' && shard !== 'b') {
  throw new Error('Set SHARD to "a" or "b" before running a Prisma command.');
}

const varName = shard === 'a' ? 'SHARD_A_DIRECT_URL' : 'SHARD_B_DIRECT_URL';
const url = process.env[varName];
if (!url) {
  throw new Error(`${varName} is not set.`);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
