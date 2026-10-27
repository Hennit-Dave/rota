import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { describeShiftFailure, type ShiftFailure } from '../../../../shifts/shiftFailure';
import { shiftFormCopy } from '../../../../shifts/shiftCopy';
import { changesFrom, valuesFromShift } from '../../../../shifts/shiftForm';
import { shiftLoadState } from '../../../../shifts/shiftLoadState';
import { ShiftFormView } from '../../../../shifts/ShiftFormView';
import { ShiftUnavailable } from '../../../../shifts/ShiftUnavailable';
import { useScheduleContext } from '../../../../shifts/useScheduleContext';
import { useShift, useShiftMutations } from '../../../../shifts/useShifts';
import { ColorsOverrideProvider, lightColors, space } from '../../../../theme';
import { Button } from '../../../../ui/Button';
import { PageHeader } from '../../../../ui/PageHeader';
import { Screen } from '../../../../ui/Screen';
import { StatusBanner } from '../../../../ui/StatusBanner';

/**
 * Edit shift (Figma 10:317): the same fields as create, filled from the server's copy of the shift; only what changed is sent. A shift that was
 * deleted meanwhile shows "isn't available". Light-only (issue #24).
 */
export default function EditShiftScreen() {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <EditShift />
    </ColorsOverrideProvider>
  );
}

function EditShift() {
  const { shiftId } = useLocalSearchParams<{ shiftId: string }>();
  const { userId, teamId, teamName, timeZone, canEdit } = useScheduleContext();
  const shift = useShift(userId, teamId, shiftId);
  const { update } = useShiftMutations(userId, teamId);
  const [failure, setFailure] = useState<ShiftFailure | null>(null);
  const [nothingChanged, setNothingChanged] = useState(false);

  const state = shiftLoadState({ hasData: shift.data !== undefined, isError: shift.isError, error: shift.error });
  const gone = failure?.kind === 'gone';
  if (gone || state !== 'ready' || !shift.data || !timeZone) {
    const shown = gone ? 'gone' : state === 'ready' ? 'loading' : state;
    return <ShiftUnavailable state={shown} teamName={teamName} error={shift.error} onRetry={() => void shift.refetch()} />;
  }
  const data = shift.data;

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={shiftFormCopy.editTitle} subtitle={shiftFormCopy.roleLine} />
      {!canEdit ? <StatusBanner tone="warning" title={shiftFormCopy.errors.forbidden} /> : null}
      {nothingChanged ? <StatusBanner tone="info" title={shiftFormCopy.errors.nothingChanged} testID="shift-nothing-changed" /> : null}
      <ShiftFormView
        mode="edit"
        initial={valuesFromShift(data, timeZone)}
        fallbackAssignee={data.assignee}
        timeZone={timeZone}
        userId={userId}
        teamId={teamId}
        failure={failure}
        pending={update.isPending}
        onSubmit={async (values, startsAt, endsAt) => {
          setFailure(null);
          const changes = changesFrom(data, { title: values.title, startsAt, endsAt, assigneeId: values.assigneeId });
          setNothingChanged(Object.keys(changes).length === 0);
          if (Object.keys(changes).length === 0) return;
          try {
            await update.mutateAsync({ shiftId: data.id, changes });
            router.back();
          } catch (error) {
            setFailure(describeShiftFailure(error));
            throw error;
          }
        }}
      />
      <Button
        label={shiftFormCopy.deleteShift}
        variant="danger"
        onPress={() => router.push({ pathname: '/shift/[shiftId]/delete', params: { shiftId: data.id } })}
        testID="shift-edit-delete"
      />
    </Screen>
  );
}
