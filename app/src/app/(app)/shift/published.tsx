import { router, useLocalSearchParams } from 'expo-router';
import { publishedCopy } from '../../../shifts/shiftCopy';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { useShift } from '../../../shifts/useShifts';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { InfoCard } from '../../../ui/InfoCard';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';

/** Shift published (Figma 7:135). The shift shown is the server's answer to the create request, held in the cache. */
export default function PublishedScreen() {
  return <Published />;
}

function Published() {
  const { shiftId } = useLocalSearchParams<{ shiftId: string }>();
  const { userId, teamId, teamName } = useScheduleContext();
  const shift = useShift(userId, teamId, shiftId);
  const who = shift.data?.assignee?.name ?? 'Open shift';
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={publishedCopy.title} subtitle={publishedCopy.subtitle} />
      <InfoCard title={publishedCopy.statusTitle} body={publishedCopy.statusBody} testID="published-status" />
      {shift.data ? <InfoCard title={publishedCopy.cardDetail(shift.data.title, who)} testID="published-shift" /> : null}
      <Spacer />
      <Button label={publishedCopy.view} onPress={() => router.dismissTo('/')} testID="published-view" />
    </Screen>
  );
}
