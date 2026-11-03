import type { createApiClient } from '../api/client';
import type { DevicesApi } from './registration';

type Client = Pick<ReturnType<typeof createApiClient>, 'put' | 'post'>;

/** The device routes (ADR 0032) over the one API client. Whose device it is is the signed-in user, never sent. */
export function createDevicesApi(client: Client): DevicesApi {
  return {
    async register(expoToken) {
      await client.put('/devices', { expoToken });
    },
    async unregister(expoToken) {
      await client.post('/devices/unregister', { expoToken });
    },
  };
}
