import { router } from 'expo-router';
import { sessionEndedCopy } from '../../auth/copy';
import { useSessionStore } from '../../state/sessionStore';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';

/** Shown when the server ended the session (Figma 100:218). Nothing else is offered: sign in again. */
export default function SessionEndedScreen() {
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={sessionEndedCopy.title} subtitle={sessionEndedCopy.subtitle} />
      <StatusBanner tone="info" title={sessionEndedCopy.bannerTitle} body={sessionEndedCopy.bannerBody} />
      <Spacer />
      <Button
        label={sessionEndedCopy.submit}
        testID="session-ended-sign-in"
        onPress={() => {
          useSessionStore.getState().clearSignOutNotice();
          router.replace('/login');
        }}
      />
    </Screen>
  );
}
