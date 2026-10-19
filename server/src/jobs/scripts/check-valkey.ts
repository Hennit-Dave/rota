import { createProducerConnection, verifyNoEviction } from '../connection.js';

console.log('Checking Valkey connection and noeviction policy...');

const redis = createProducerConnection();

try {
  await redis.connect();
  const ping = await redis.ping();
  console.log(`Valkey PING response: ${ping}`);

  await verifyNoEviction(redis);
  console.log('Valkey maxmemory-policy successfully verified as noeviction.');

  const info = await redis.info('server');
  const versionMatch = info.match(/valkey_version:([^\r\n]+)/) || info.match(/redis_version:([^\r\n]+)/);
  console.log(`Server version: ${versionMatch ? versionMatch[1] : 'unknown'}`);
} catch (err: any) {
  console.error(`Valkey check failed: ${err.message}`);
  process.exit(1);
} finally {
  await redis.quit();
}
