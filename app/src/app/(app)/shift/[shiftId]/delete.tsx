import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { describeShiftFailure, type ShiftFailure } from '../../../../shifts/shiftFailure';
import { deleteShiftCopy } from '../../../../shifts/shiftCopy';
import { shiftLoadState } from '../../../../shifts/shiftLoadState';
import { formatLongDate, dayKeyOf, formatRange } from '../../../../shifts/shiftTime';
import { ShiftUnavailable } from '../../../../shifts/ShiftUnavailable';
import { useScheduleContext } from '../../../../shifts/useScheduleContext';
import { useShift, useShiftMutations } from '../../../../shifts/useShifts';
import { space } from '../../../../theme';
import { Button } from '../../../../ui/Button';
import { InfoCard } from '../../../../ui/InfoCard';
import { createLatch } from '../../../../ui/latch';
import { PageHeader } from '../../../../ui/PageHeader';
import { Screen, Spacer } from '../../../../ui/Screen';
import { StatusBanner } from '../../../../ui/StatusBanner';
import { useOnline } from '../../../../ui/useOnline';

/**
 * Delete this shift? (Figma 10:337): asks first because it cannot be undone. The server decides who may delete; the app never assumes it worked until the
 * request answered. A shift that is already gone is treated as deleted.
 */
export default function DeleteShiftScreen() {
  return <DeleteShift />;
}

function DeleteShift() {
  const online = useOnline();
  const { shiftId } = useLocalSearchParams<{ shiftId: string }>();
  const { userId, teamId, teamName, timeZone } = useScheduleContext();
  const shift = useShift(userId, teamId, shiftId);
  const { remove } = useShiftMutations(userId, teamId);
  const [latch] = useState(createLatch);
  const [failure, setFailure] = useState<ShiftFailure | null>(null);

  const state = shiftLoadState({ hasData: shift.data !== undefined, isError: shift.isError, error: shift.error });
  if (failure?.kind === 'gone' || state !== 'ready' || !shift.data || !timeZone) {
    const shown = failure?.kind === 'gone' ? 'gone' : state === 'ready' ? 'loading' : state;
    return <ShiftUnavailable state={shown} teamName={teamName} error={shift.error} onRetry={() => void shift.refetch()} />;
  }
  const data = shift.data;
  const start = new Date(data.startsAt);

  async function confirm() {
    if (!latch.tryAcquire()) return;
    setFailure(null);
    try {
      await remove.mutateAsync(data.id);
      router.dismissTo('/');
    } catch (error) {
      setFailure(describeShiftFailure(error));
    } finally {
      latch.release();
    }
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={deleteShiftCopy.title} subtitle={deleteShiftCopy.subtitle} />
      <InfoCard
        title={data.title}
        body={`${formatLongDate(dayKeyOf(start, timeZone))}\n${formatRange(start, new Date(data.endsAt), timeZone)}`}
        testID="delete-shift-summary"
      />
      {failure && failure.kind !== 'fields' ? (
        <StatusBanner
          tone={failure.kind === 'generic' ? 'error' : 'warning'}
          title={failure.message}
          reference={failure.kind === 'generic' && failure.reference ? failure.reference : undefined}
          testID="delete-shift-failure"
        />
      ) : null}
      <Spacer />
      <Button
        label={deleteShiftCopy.confirm}
        variant="danger"
        loading={remove.isPending}
        loadingLabel={deleteShiftCopy.deleting}
        disabled={!online}
        onPress={() => void confirm()}
        testID="delete-shift-confirm"
      />
      <Button label={deleteShiftCopy.keep} variant="secondary" disabled={remove.isPending} onPress={() => router.back()} testID="delete-shift-keep" />
    </Screen>
  );
}
