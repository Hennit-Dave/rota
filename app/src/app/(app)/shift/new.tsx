import { router } from 'expo-router';
import { useState } from 'react';
import { describeShiftFailure, type ShiftFailure } from '../../../shifts/shiftFailure';
import { shiftFormCopy } from '../../../shifts/shiftCopy';
import { dayKeyOf } from '../../../shifts/shiftTime';
import { ShiftFormView } from '../../../shifts/ShiftFormView';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { useShiftMutations } from '../../../shifts/useShifts';
import { space } from '../../../theme';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';

/**
 * Create shift (Figma 7:67). Only an Owner or Manager gets the button that leads here, and the server refuses anyone else; a Staff member who reaches
 * the screen anyway sees the server's refusal as a message on submit. On success the server's answer is shown on the published screen.
 */
export default function NewShiftScreen() {
  return <NewShift />;
}

function NewShift() {
  const { userId, teamId, teamName, timeZone, canEdit, detail } = useScheduleContext();
  const { create } = useShiftMutations(userId, teamId);
  const [failure, setFailure] = useState<ShiftFailure | null>(null);

  if (!timeZone) {
    return (
      <Screen gap={space[16]}>
        <PageHeader eyebrowGap={16} teamName={teamName} title={shiftFormCopy.createTitle} subtitle={shiftFormCopy.roleLine} />
        {detail.isError ? <StatusBanner tone="error" title="We couldn’t load your team." /> : null}
      </Screen>
    );
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={shiftFormCopy.createTitle} subtitle={shiftFormCopy.roleLine} />
      {!canEdit ? <StatusBanner tone="warning" title={shiftFormCopy.errors.forbidden} /> : null}
      <ShiftFormView
        mode="create"
        initial={{ title: '', date: dayKeyOf(new Date(), timeZone), start: '', end: '', assigneeId: null }}
        timeZone={timeZone}
        userId={userId}
        teamId={teamId}
        failure={failure}
        pending={create.isPending}
        onSubmit={async (values, startsAt, endsAt) => {
          setFailure(null);
          try {
            const shift = await create.mutateAsync({
              title: values.title.trim(),
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              assignedUserId: values.assigneeId,
            });
            router.replace({ pathname: '/shift/published', params: { shiftId: shift.id } });
          } catch (error) {
            setFailure(describeShiftFailure(error));
            throw error;
          }
        }}
      />
    </Screen>
  );
}
