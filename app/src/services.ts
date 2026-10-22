import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { createApiClient } from './api/client';
import { readApiBaseUrl } from './api/config';
import { shouldRetryQuery, type Logger } from './api/errors';
import { createAuthActions } from './auth/authActions';
import type { AuthUser } from './auth/authResponses';
import { createRestoreSession } from './auth/restore';
import { createSessionActions } from './auth/session';
import { AccountEpoch } from './auth/epoch';
import { secureTokenStore } from './auth/secureTokenStore';
import { createSignOutLocal } from './auth/signOut';
import { useSessionStore } from './state/sessionStore';

/**
 * Composition root: the real instances, built once. Everything below the line is plain, injected, unit-tested code.
 * The log keeps to event names and primitive fields so it can never be handed a token or a body.
 */
const logger: Logger = {
  warn: (event, fields) => console.warn(`[rota] ${event}`, fields ?? {}),
};

export const epoch = new AccountEpoch();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: shouldRetryQuery },
    // Mutations never retry by default; settings and swaps additionally set networkMode 'always' (app-state.md).
    mutations: { retry: 0 },
  },
});

export const signOutLocal = createSignOutLocal({
  epoch,
  logger,
  steps: {
    clearQueryCaches: async () => {
      await queryClient.cancelQueries();
      queryClient.clear(); // clears the query cache and the mutation cache
    },
    // The persister arrives with the offline-shifts slice; there is nothing persisted yet.
    clearPersistedCache: () => {},
    resetClientState: (notice) => useSessionStore.getState().resetForSignOut(notice),
    clearTokens: () => secureTokenStore.clear(),
  },
});

let apiClient: ReturnType<typeof createApiClient> | null = null;

/** Built on first use so a missing or invalid EXPO_PUBLIC_API_URL shows as a screen message, not a crash at import. */
export function getApi() {
  apiClient ??= createApiClient({
    baseUrl: readApiBaseUrl(),
    fetch: (input, init) => fetch(input, init),
    tokens: secureTokenStore,
    epoch,
    isOnline: () => onlineManager.isOnline(),
    onSessionInvalid: () => signOutLocal('session_ended'),
    logger,
  });
  return apiClient;
}

export function getSessionActions() {
  return createSessionActions({
    client: getApi(),
    isOnline: () => onlineManager.isOnline(),
    signOutLocal,
  });
}

/** Foreground and connectivity feed TanStack Query (app-state.md). Call once, at app start. */
export function wireQueryManagers(): () => void {
  focusManager.setEventListener((handleFocus) => {
    const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
    return () => sub.remove();
  });
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(state.isConnected !== false && state.isInternetReachable !== false)),
  );
  return () => {
    focusManager.setEventListener(() => () => {});
    onlineManager.setEventListener(() => () => {});
  };
}

/** The one query that describes the signed-in user. Personal, so sign-out clears the whole cache (app-state.md). */
export const meQueryKey = ['me'] as const;

/** A session now exists (sign-in, sign-up, or a restore): seed the user the server returned and open the signed-in side. */
function onSignedIn(user: AuthUser | null) {
  if (user) queryClient.setQueryData(meQueryKey, user);
  useSessionStore.getState().setSignedIn();
}

/** Sign in and sign up. Built on first use, like the API client, so a bad API address surfaces as an error on submit. */
export function getAuthActions() {
  return createAuthActions({
    client: getApi(),
    tokens: secureTokenStore,
    epoch,
    onSignedIn: (user) => onSignedIn(user),
  });
}

/**
 * App start: decide which side to show only after the stored session has been checked with the server (docs/STATE.md).
 * Offline or unreachable keeps the session and shows the signed-in side with its own offline state (app-state.md).
 */
export async function restoreSession(): Promise<void> {
  let client: ReturnType<typeof getApi>;
  try {
    client = getApi();
  } catch {
    // No usable API address (a misconfigured build): nothing can be verified. Show the sign-in side; submitting reports it.
    useSessionStore.getState().setSignedOut();
    return;
  }
  await createRestoreSession({
    tokens: secureTokenStore,
    client,
    signOutLocal,
    onSignedIn,
    onSignedOut: () => useSessionStore.getState().setSignedOut(),
  })();
}
