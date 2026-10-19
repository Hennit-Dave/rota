import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyNoEviction } from './connection.js';
import { enqueueWorkRow, formatJobId } from './queue.js';
import {
  formatCheckValkeyError,
  formatJobFailedLog,
  formatWorkerError,
  formatWorkerInitError,
  redactSensitive,
  sanitizeError,
} from './redact.js';
import { createWorkProcessor, resolvePrismaClient } from './worker.js';

test('verifyNoEviction: verifies noeviction policy and rejects other policies', async () => {
  // Test 1: valid noeviction via INFO memory
  const mockValidRedis: any = {
    info: async () => 'some_info\r\nmaxmemory_policy:noeviction\r\nother_info',
  };
  await assert.doesNotReject(() => verifyNoEviction(mockValidRedis));

  // Test 2: invalid policy via INFO memory
  const mockInvalidRedis: any = {
    info: async () => 'some_info\r\nmaxmemory_policy:allkeys-lru\r\nother_info',
  };
  await assert.rejects(
    () => verifyNoEviction(mockInvalidRedis),
    /Expected 'noeviction'\. Startup refused\./,
  );

  // Test 3: fallback to CONFIG GET when INFO lacks maxmemory_policy
  const mockConfigFallback: any = {
    info: async () => 'no_policy_here',
    config: async () => ['maxmemory-policy', 'noeviction'],
  };
  await assert.doesNotReject(() => verifyNoEviction(mockConfigFallback));

  // Test 4: unverified policy throws
  const mockUnverified: any = {
    info: async () => 'empty',
    config: async () => {
      throw new Error('CONFIG GET disabled');
    },
  };
  await assert.rejects(
    () => verifyNoEviction(mockUnverified),
    /Expected 'noeviction'\. Startup refused\./,
  );
});

test('formatJobId: produces deterministic BullMQ custom ID without colons', () => {
  const rowId = 'd89c9417-3bf9-470d-b152-cbce9d846513';
  const jobId = formatJobId(rowId, 1);
  assert.equal(jobId, `work-${rowId}-1`);
  assert.ok(!jobId.includes(':'), 'BullMQ custom job IDs must not contain colons (jobs.md)');
});

test('enqueueWorkRow: validates shard identifier without database mutations', async () => {
  const mockPrisma: any = {};
  // Missing shard in options
  await assert.rejects(
    () => enqueueWorkRow(mockPrisma, 'test', {} as any),
    /Enqueue requires a valid shard \('A' \| 'B'\)/,
  );

  // Invalid shard in options
  await assert.rejects(
    () => enqueueWorkRow(mockPrisma, 'test', { shard: 'C' as any }),
    /Enqueue requires a valid shard \('A' \| 'B'\)/,
  );
});

test('createWorkProcessor: rejects missing or invalid shard in job payload', async () => {
  const processor = createWorkProcessor({} as any, {});

  // Missing shard
  const jobWithoutShard: any = { id: 'job-1', data: { rowId: 'row-1', generation: 1 } };
  await assert.rejects(
    () => processor(jobWithoutShard),
    /Job job-1 has invalid or missing shard identifier/,
  );

  // Invalid shard
  const jobWithInvalidShard: any = { id: 'job-2', data: { rowId: 'row-1', generation: 1, shard: 'Z' } };
  await assert.rejects(
    () => processor(jobWithInvalidShard),
    /Job job-2 has invalid or missing shard identifier: 'Z'/,
  );
});

test('resolvePrismaClient: correctly routes to shard A and B primaries', () => {
  const mockPrimaryA: any = { name: 'primary-A' };
  const mockPrimaryB: any = { name: 'primary-B' };
  const mockShards: any = {
    A: { primary: mockPrimaryA },
    B: { primary: mockPrimaryB },
  };

  assert.equal(resolvePrismaClient(mockShards, 'A'), mockPrimaryA);
  assert.equal(resolvePrismaClient(mockShards, 'B'), mockPrimaryB);

  // Single client fallback
  const mockSinglePrisma: any = { $queryRaw: async () => [] };
  assert.equal(resolvePrismaClient(mockSinglePrisma, 'A'), mockSinglePrisma);
  assert.equal(resolvePrismaClient(mockSinglePrisma, 'B'), mockSinglePrisma);
});

test('redactSensitive & sanitizeError: thoroughly redacts synthetic credential-bearing errors', () => {

  // Synthetic error 1: PostgreSQL URL with username and password
  const pgErr = new Error(
    'Connection failed to postgresql://rota_user:super_secret_pw123@ep-cool-shard.us-east-2.aws.neon.tech:5432/neondb?sslmode=require',
  );
  const sanitizedPg = sanitizeError(pgErr);
  assert.ok(!sanitizedPg.includes('super_secret_pw123'), 'Password must be redacted');
  assert.ok(!sanitizedPg.includes('rota_user'), 'Username must be redacted');
  assert.ok(sanitizedPg.includes('[REDACTED_USER]:[REDACTED_PASS]@'), 'Redacted marker must be present');

  // Synthetic error 2: Valkey TLS connection string with secret token
  const valkeySecret = 'valkey_secret_password_token_123';
  const valkeyErr = new Error(
    `Valkey command timeout on rediss://default:${valkeySecret}@rota-valkey-prj.example.com:25345`,
  );
  const sanitizedValkey = sanitizeError(valkeyErr);
  assert.ok(!sanitizedValkey.includes(valkeySecret), 'Valkey token must be redacted');
  assert.ok(sanitizedValkey.includes('[REDACTED_USER]:[REDACTED_PASS]@'), 'Redacted marker must be present');

  // Synthetic error 3: Stripe secret key
  const stripePrefix = ['sk', 'test'].join('_');
  const stripeSecret = `${stripePrefix}_syntheticStripeKeySample12345`;
  const stripeErr = new Error(`Stripe authentication failed for key ${stripeSecret}`);
  const sanitizedStripe = sanitizeError(stripeErr);
  assert.ok(!sanitizedStripe.includes(stripeSecret), 'Stripe key must be redacted');
  assert.ok(sanitizedStripe.includes('[REDACTED_SECRET]'), 'Redacted marker must be present');

  // Synthetic error 4: Resend API key
  const resendPrefix = ['re', 'sampleApiKeyPrefix'].join('_');
  const resendSecret = `${resendPrefix}_123456789abcdef`;
  const resendErr = new Error(`Resend 401 unauthorized: key ${resendSecret} was invalid`);
  const sanitizedResend = sanitizeError(resendErr);
  assert.ok(!sanitizedResend.includes(resendSecret), 'Resend key must be redacted');
  assert.ok(sanitizedResend.includes('[REDACTED_SECRET]'), 'Redacted marker must be present');

  // Synthetic error 5: Bearer token and password query param
  const authErr = new Error(
    'Failed to authenticate: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig with query ?password=myHiddenPass123&token=secretTok',
  );
  const sanitizedAuth = sanitizeError(authErr);
  assert.ok(!sanitizedAuth.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'Bearer token must be redacted');
  assert.ok(!sanitizedAuth.includes('myHiddenPass123'), 'Query password must be redacted');
  assert.ok(!sanitizedAuth.includes('secretTok'), 'Query token must be redacted');
});

test('logging paths: formatWorkerInitError, formatWorkerError, formatJobFailedLog, and formatCheckValkeyError redact credentials', () => {
  const secretPw = 'super_secret_test_password_456';
  const rawErr = new Error(
    `Connection refused to postgresql://admin_user:${secretPw}@ep-cool-shard.us-east-2.aws.neon.tech:5432/neondb`,
  );

  // 1. worker init failure logging path
  const initMsg = formatWorkerInitError(rawErr);
  assert.ok(initMsg.startsWith('worker failed to initialize valkey connection:'));
  assert.ok(!initMsg.includes(secretPw), 'worker init log must not leak password');
  assert.ok(initMsg.includes('[REDACTED_USER]:[REDACTED_PASS]@'), 'worker init log must redact user and pass');

  // 2. worker runtime error logging path
  const runtimeMsg = formatWorkerError(rawErr);
  assert.ok(runtimeMsg.startsWith('worker error:'));
  assert.ok(!runtimeMsg.includes(secretPw), 'worker error log must not leak password');
  assert.ok(runtimeMsg.includes('[REDACTED_USER]:[REDACTED_PASS]@'), 'worker error log must redact user and pass');

  // 3. job failed logging path
  const jobMsg = formatJobFailedLog('work-test-1', rawErr);
  assert.ok(jobMsg.startsWith('job work-test-1 failed:'));
  assert.ok(!jobMsg.includes(secretPw), 'job failed log must not leak password');
  assert.ok(jobMsg.includes('[REDACTED_USER]:[REDACTED_PASS]@'), 'job failed log must redact user and pass');

  // 4. check-valkey error logging path
  const valkeySecret = 'valkey_probe_secret_token_789';
  const valkeyErr = new Error(`Command failed on rediss://default:${valkeySecret}@probe.example.com:25345`);
  const checkValkeyMsg = formatCheckValkeyError(valkeyErr);
  assert.ok(checkValkeyMsg.startsWith('Valkey check failed:'));
  assert.ok(!checkValkeyMsg.includes(valkeySecret), 'check-valkey log must not leak token');
  assert.ok(checkValkeyMsg.includes('[REDACTED_USER]:[REDACTED_PASS]@'), 'check-valkey log must redact credentials');
});
