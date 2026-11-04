import NetInfo from '@react-native-community/netinfo';
import { MutationCache, QueryCache, QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { createApiClient } from './api/client';
import { readApiBaseUrl } from './api/config';
import { type Logger } from './api/errors';
import { queryClientDefaults } from './api/queryDefaults';
import { reportQueryError, setSentryTeam, setSentryUser } from './observability/sentry';
import { createAuthActions } from './auth/authActions';
import type { AuthUser } from './auth/authResponses';
import { createRestoreSession } from './auth/restore';
import { createSessionActions } from './auth/session';
import { AccountEpoch } from './auth/epoch';
import { secureTokenStore } from './auth/secureTokenStore';
import { createSignOutLocal } from './auth/signOut';
import { createDevicesApi } from './notifications/devicesApi';
import { unregisterThisDevice } from './notifications/registration';
import { expoPlatform } from './notifications/expoPlatform';
import { useSessionStore } from './state/sessionStore';
import { createInviteApi } from './invites/inviteApi';
import { createRecoveryApi } from './recovery/recoveryApi';
import { createActivityApi } from './activity/activityApi';
import { createShiftApi } from './shifts/shiftApi';
import { createSettingsApi } from './settings/settingsApi';
import { settingsKey } from './settings/settingsResponses';
import { createBillingApi } from './billing/billingApi';
import { createSwapApi } from './swaps/swapApi';
import { createTeamApi } from './teams/teamApi';
import { OFFLINE_MAX_AGE_MS } from './offline/offlineConfig';
import { createOfflineSaving } from './offline/offlineSaving';
import { createSqliteStore } from './offline/sqliteStore';
import { UPCOMING_ROOT } from './offline/upcoming';

/**
 * Composition root: the real instances, built once. Everything below the line is plain, injected, unit-tested code.
 * The log keeps to event names and primitive fields so it can never be handed a token or a body.
 */
const logger: Logger = {
  warn: (event, fields) => console.warn(`[rota] ${event}`, fields ?? {}),
};

export const epoch = new AccountEpoch();

export const queryClient = new QueryClient({
  defaultOptions: queryClientDefaults,
  // An unexpected failure (a bug, a server error) goes to Sentry with the failing response's request ID; an ordinary one (offline, a refused request, a session that
  // ended) does not (observability/reportable.ts, ADR 0039).
  queryCache: new QueryCache({ onError: reportQueryError }),
  mutationCache: new MutationCache({ onError: reportQueryError }),
});

// Sentry's team tag follows the team that is open, and its user is cleared whenever nobody is signed in. Every sign-out path resets this store, so this covers a manual
// sign-out, a session the server ended, and a failed restore alike; the user is set in `onSignedIn` below.
useSessionStore.subscribe((state) => {
  setSentryTeam(state.selectedTeamId);
  if (state.status === 'signedOut') setSentryUser(null);
});

// The saved copy must outlive the usual 5 minutes in memory, or a copy put back from the device would be dropped before anyone looked at it (and the next save
// would then forget it): its gcTime is the maximum age (docs/STATE.md).
queryClient.setQueryDefaults([UPCOMING_ROOT], { gcTime: OFFLINE_MAX_AGE_MS });

/** The only thing kept on the device besides the tokens: the person's upcoming shifts (ADR 0010, ADR 0034). */
export const offlineSaving = createOfflineSaving({ queryClient, store: createSqliteStore(), epoch, maxAgeMs: OFFLINE_MAX_AGE_MS, logger });

export const signOutLocal = createSignOutLocal({
  epoch,
  logger,
  steps: {
    clearQueryCaches: async () => {
      await queryClient.cancelQueries();
      queryClient.clear(); // clears the query cache and the mutation cache
    },
    clearPersistedCache: () => offlineSaving.stopAndClear(),
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

/** The team routes over the one API client. Built on first use, like the client. */
export function getTeamApi() {
  return createTeamApi(getApi());
}

/** The shift routes (docs/ARCHITECTURE.md 5d) over the one API client. Built on first use, like the client. */
export function getShiftApi() {
  return createShiftApi(getApi());
}

/** The swap routes (docs/ARCHITECTURE.md 5f) over the one API client. Built on first use, like the client. */
export function getSwapApi() {
  return createSwapApi(getApi());
}

/** The billing routes (docs/ARCHITECTURE.md 5i, ADR 0027) over the one API client. Built on first use, like the client. */
export function getBillingApi() {
  return createBillingApi(getApi());
}

/** The push device routes (ADR 0032) over the one API client. */
export function getDevicesApi() {
  return createDevicesApi(getApi());
}

/** The settings routes (docs/ARCHITECTURE.md, ADR 0024) over the one API client. Built on first use, like the client. */
export function getSettingsApi() {
  return createSettingsApi(getApi());
}

/** The settings request started when a session began, so the launch screen can wait for it (and so the theme is right on the first frame). */
let settingsPrefetch: Promise<void> | null = null;

/**
 * Asks for the user's settings once, without retries: a failure (offline, a slow or unhappy server) must never hold the launch screen longer than the one
 * request's own timeout. It never throws. The screens' own observer asks again as soon as one mounts (`staleTime: 0`).
 */
export function prefetchSettings(userId: string): Promise<void> {
  settingsPrefetch = queryClient.prefetchQuery({
    queryKey: settingsKey(userId),
    queryFn: ({ signal }) => getSettingsApi().get(signal),
    retry: false,
    networkMode: 'always',
    staleTime: 0,
  });
  return settingsPrefetch;
}

/** Resolves when the settings request of this session has finished, however it ended (or at once when none was started). */
export function settingsPrefetchSettled(): Promise<void> {
  return settingsPrefetch ?? Promise.resolve();
}

/** The activity feed route (docs/ARCHITECTURE.md 5e) over the one API client. Built on first use, like the client. */
export function getActivityApi() {
  return createActivityApi(getApi());
}

/** The two invite-link routes (preview, accept) over the one API client. */
export function getInviteApi() {
  return createInviteApi(getApi());
}

/** The reset and magic-link requests (ADR 0020) over the one API client. Built on first use, like the client. */
export function getRecoveryApi() {
  return createRecoveryApi(getApi());
}

export function getSessionActions() {
  return createSessionActions({
    client: getApi(),
    isOnline: () => onlineManager.isOnline(),
    signOutLocal,
    // Before the session is revoked (the call needs it): stop this phone getting the signed-out person's notifications. Best effort; never throws.
    beforeLogout: () => unregisterThisDevice({ platform: expoPlatform, api: getDevicesApi() }),
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
  if (user) {
    setSentryUser(user.id); // the ID only, never an email or a name
    queryClient.setQueryData(meQueryKey, user);
    void prefetchSettings(user.id);
    void offlineSaving.begin(user.id);
  }
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
  // The saved shifts go back into the cache before either side is shown, so an offline start can use them. Never throws.
  await offlineSaving.restoreOnStart();
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
