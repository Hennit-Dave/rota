import { createProducerConnection, verifyNoEviction } from '../connection.js';
import { formatCheckValkeyError } from '../redact.js';

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
  console.error(formatCheckValkeyError(err));
  process.exit(1);
} finally {
  await redis.quit();
}
