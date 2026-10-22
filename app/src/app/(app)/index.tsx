import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { ApiError, OfflineError } from '../../api/errors';
import { bannerCopy, homeCopy } from '../../auth/copy';
import { parseMe } from '../../auth/authResponses';
import { getApi, getSessionActions, meQueryKey } from '../../services';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';
import { Text } from '../../ui/Text';
import { TextAction } from '../../ui/TextAction';
import { useOnline } from '../../ui/useOnline';

/**
 * PLACEHOLDER home: "Signed in as <name>" with both sign-out flows, so they can be proven end to end. The real home and
 * settings come in later slices. The name is server data (GET /auth/me), seeded at sign-in and refetched when the app
 * returns to the foreground.
 */
export default function HomeScreen() {
  const online = useOnline();
  const [busy, setBusy] = useState<'logout' | 'logoutAll' | null>(null);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);

  const me = useQuery({
    queryKey: meQueryKey,
    queryFn: async ({ signal }) => {
      const user = parseMe(await getApi().get<unknown>('/auth/me', { signal }));
      if (!user) throw new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
      return user;
    },
    // Seeded at sign-in or restore; refetched on foreground by the focus manager. No separate number to explain.
    refetchOnMount: false,
  });

  async function logout() {
    if (busy) return;
    setBusy('logout');
    try {
      await getSessionActions().logout(); // the sign-out resets the store; the signed-out side replaces this screen
    } finally {
      setBusy(null);
    }
  }

  async function logoutAll() {
    if (busy) return;
    setBusy('logoutAll');
    setLogoutAllError(null);
    try {
      await getSessionActions().logoutAll();
    } catch (error) {
      setLogoutAllError(error instanceof OfflineError ? homeCopy.logoutAllOffline : homeCopy.logoutAllFailed);
    } finally {
      setBusy(null);
    }
  }

  let status: React.ReactNode = null;
  if (me.data) {
    status = <Text variant="heading">{homeCopy.signedInAs(me.data.name)}</Text>;
  } else if (!online) {
    status = <StatusBanner tone="warning" title={homeCopy.offlineTitle} body={homeCopy.offlineBody} />;
  } else if (me.isError) {
    const reference = me.error instanceof ApiError && me.error.requestId ? `${bannerCopy.referencePrefix}${me.error.requestId}` : undefined;
    status = (
      <>
        <StatusBanner tone="error" title={homeCopy.couldNotLoad} reference={reference} />
        <Button label={homeCopy.retry} variant="secondary" onPress={() => void me.refetch()} testID="home-retry" />
      </>
    );
  } else {
    status = <Text variant="heading">{homeCopy.signedIn}</Text>;
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={homeCopy.title} />
      {status}
      <Text variant="caption" tone="muted">
        {homeCopy.placeholderNote}
      </Text>
      {logoutAllError ? <StatusBanner tone="error" title={logoutAllError} /> : null}
      <Spacer />
      {__DEV__ ? <TextAction label="API check (development only)" onPress={() => router.push('/dev-api')} /> : null}
      <Button
        label={homeCopy.logout}
        loading={busy === 'logout'}
        loadingLabel={homeCopy.loggingOut}
        disabled={busy === 'logoutAll'}
        onPress={() => void logout()}
        testID="home-logout"
      />
      <Button
        label={homeCopy.logoutAll}
        variant="secondary"
        loading={busy === 'logoutAll'}
        loadingLabel={homeCopy.loggingOutAll}
        disabled={busy === 'logout'}
        onPress={() => void logoutAll()}
        testID="home-logout-all"
      />
    </Screen>
  );
}
