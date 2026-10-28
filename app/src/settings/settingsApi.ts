import type { createApiClient } from '../api/client';
import { parseSettingsResponse, type SettingChange, type Settings } from './settingsResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'patch'>;

/** The settings routes (docs/ARCHITECTURE.md, ADR 0024). Plain functions over the API client, so they are unit-tested without a screen. */
export function createSettingsApi(client: Client) {
  return {
    /** GET /settings: all the caller's settings. Whose they are is the signed-in user, never sent. */
    async get(signal?: AbortSignal): Promise<Settings> {
      return parseSettingsResponse(await client.get<unknown>('/settings', { signal }));
    },
    /**
     * PATCH /settings: ONE field per request (the server refuses a body with two). No `updatedAt` and no user ID is sent: the server stamps the change
     * when it arrives, and the answer carries every setting as the server now holds it.
     */
    async change(change: SettingChange): Promise<Settings> {
      return parseSettingsResponse(await client.patch<unknown>('/settings', { [change.key]: change.value }));
    },
  };
}
