import { router } from 'expo-router';
import { placeholderCopy } from '../../auth/copy';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';

/** PLACEHOLDER for the create-team step that follows sign-up (Figma 8:101, built in a later slice). Not a dead end: it skips to home. */
export default function CreateTeamPlaceholder() {
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={placeholderCopy.createTeam.title} />
      <StatusBanner tone="info" title={placeholderCopy.badge} body={placeholderCopy.createTeam.body} />
      <Spacer />
      <Button label={placeholderCopy.skip} variant="secondary" onPress={() => router.replace('/')} testID="create-team-skip" />
    </Screen>
  );
}
