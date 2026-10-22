import NetInfo from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useState } from 'react';
import { signedOutOfflineCopy } from '../../auth/copy';
import { useSessionStore } from '../../state/sessionStore';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';

function goToLogin() {
  useSessionStore.getState().clearSignOutNotice();
  router.replace('/login');
}

/**
 * Shown after a logout the server could not confirm (offline, or the revoke failed): the phone is signed out, but the
 * server session may still be alive (Figma 100:232, docs/STATE.md). "Try again" re-checks the connection and stays
 * enabled (Figma note 232:415); "Close" goes on to the login screen.
 */
export default function SignedOutOfflineScreen() {
  const [checking, setChecking] = useState(false);

  async function recheck() {
    if (checking) return;
    setChecking(true);
    try {
      const state = await NetInfo.fetch();
      if (state.isConnected !== false && state.isInternetReachable !== false) goToLogin();
    } finally {
      setChecking(false);
    }
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={signedOutOfflineCopy.title} subtitle={signedOutOfflineCopy.subtitle} />
      <StatusBanner tone="warning" title={signedOutOfflineCopy.bannerTitle} body={signedOutOfflineCopy.bannerBody} />
      <Spacer />
      <Button
        label={signedOutOfflineCopy.retry}
        loading={checking}
        loadingLabel={signedOutOfflineCopy.retry}
        onPress={() => void recheck()}
        testID="signed-out-offline-retry"
      />
      <Button label={signedOutOfflineCopy.close} variant="secondary" onPress={goToLogin} testID="signed-out-offline-close" />
    </Screen>
  );
}
