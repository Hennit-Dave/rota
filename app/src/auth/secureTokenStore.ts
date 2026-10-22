import * as SecureStore from 'expo-secure-store';
import type { TokenPair, TokenStore } from './types';

// One item holding both tokens, so a crash can never leave an access token from one refresh next to the refresh
// token from another. Tokens exist nowhere else on the device: not AsyncStorage, not the query cache, not logs.
const SESSION_KEY = 'rota.session';

export const secureTokenStore: TokenStore = {
  async read() {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as TokenPair).accessToken === 'string' &&
        typeof (parsed as TokenPair).refreshToken === 'string'
      ) {
        const { accessToken, refreshToken } = parsed as TokenPair;
        return { accessToken, refreshToken };
      }
    } catch {
      // fall through: unreadable content is treated as no session
    }
    return null;
  },
  async write(tokens) {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(tokens));
  },
  async clear() {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  },
};
