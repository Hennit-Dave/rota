import { router } from 'expo-router';
import { recoveryCopy } from '../auth/copy';
import { goBackTo } from '../invites/goBackTo';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { PageHeader } from '../ui/PageHeader';
import { Screen, Spacer } from '../ui/Screen';
import { StatusBanner } from '../ui/StatusBanner';

/**
 * One answer for a link that is expired, already used, replaced by a newer one, unknown or malformed (the server gives no finer answer, so neither
 * do we). Layout of invite-expired (8:146); this slice has no frame of its own for it. "Back to log in" for someone signed out; someone who is
 * signed in goes back to the app.
 */
export function LinkUnavailableView({ kind, signedIn }: { kind: 'magic' | 'reset'; signedIn: boolean }) {
  const copy = recoveryCopy.unavailable;
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={kind === 'magic' ? copy.magicTitle : copy.resetTitle} subtitle={copy.subtitle} />
      <StatusBanner tone="warning" title={copy.bannerTitle} body={copy.bannerBody} />
      <Spacer />
      <Button
        label={signedIn ? 'Back to Rota' : copy.backToLogin}
        onPress={() => goBackTo(router, signedIn ? '/' : '/login')}
        testID="link-unavailable-back"
      />
    </Screen>
  );
}
