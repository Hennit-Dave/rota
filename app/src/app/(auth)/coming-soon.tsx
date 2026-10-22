import { router, useLocalSearchParams } from 'expo-router';
import { placeholderCopy } from '../../auth/copy';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';

/** A clearly marked placeholder for the screens this slice links to but does not build (magic link, password reset). Not in Figma. */
export default function ComingSoonScreen() {
  const { feature } = useLocalSearchParams<{ feature?: string }>();
  const page = feature === 'magic-link' ? placeholderCopy.magicLink : placeholderCopy.forgotPassword;
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={page.title} />
      <StatusBanner tone="info" title={placeholderCopy.badge} body={page.body} />
      <Spacer />
      <Button label={placeholderCopy.back} variant="secondary" onPress={() => router.back()} testID="coming-soon-back" />
    </Screen>
  );
}
