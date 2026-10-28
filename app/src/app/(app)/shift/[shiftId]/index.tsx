import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { shiftDetailCopy } from '../../../../shifts/shiftCopy';
import { shiftLoadState } from '../../../../shifts/shiftLoadState';
import { formatLongDate, dayKeyOf, formatRange } from '../../../../shifts/shiftTime';
import { ShiftUnavailable } from '../../../../shifts/ShiftUnavailable';
import { useScheduleContext } from '../../../../shifts/useScheduleContext';
import { useShift, useShiftsRange } from '../../../../shifts/useShifts';
import { space } from '../../../../theme';
import { Button } from '../../../../ui/Button';
import { InfoCard } from '../../../../ui/InfoCard';
import { PageHeader } from '../../../../ui/PageHeader';
import { Screen, Spacer } from '../../../../ui/Screen';
import { useOnline } from '../../../../ui/useOnline';

/**
 * One shift (Figma shift 7:44, shift-staff 102:308): its status, the time and place, who else is working then, the note, and for an Owner or Manager the
 * Edit and Delete buttons. "Working with you" lists the other people whose shifts overlap this one, read from the same schedule endpoint.
 */
export default function ShiftScreen() {
  return <ShiftDetail />;
}

function ShiftDetail() {
  const online = useOnline();
  const { shiftId } = useLocalSearchParams<{ shiftId: string }>();
  const { userId, teamId, teamName, timeZone, canEdit } = useScheduleContext();
  const shift = useShift(userId, teamId, shiftId);
  const zone = timeZone ?? 'UTC';

  const window = useMemo(
    () => (shift.data ? { from: new Date(shift.data.startsAt), to: new Date(shift.data.endsAt) } : { from: new Date(0), to: new Date(1) }),
    [shift.data],
  );
  const others = useShiftsRange(userId, shift.data && timeZone ? teamId : null, window, false);

  const state = shiftLoadState({ hasData: shift.data !== undefined, isError: shift.isError, error: shift.error });
  if (state !== 'ready' || !shift.data) {
    return <ShiftUnavailable state={state === 'ready' ? 'loading' : state} teamName={teamName} error={shift.error} onRetry={() => void shift.refetch()} />;
  }

  const data = shift.data;
  const mine = data.assignee !== null && data.assignee.id === userId;
  const statusBody = mine ? shiftDetailCopy.status.mine : data.assignee ? shiftDetailCopy.status.other(data.assignee.name) : shiftDetailCopy.status.open;
  const coworkers = (others.data ?? []).filter((s) => s.id !== data.id && s.assignee !== null && s.assignee.id !== data.assignee?.id);
  const place = [teamName, data.area].filter(Boolean).join(' · ');

  return (
    <Screen gap={space[16]}>
      <PageHeader
        eyebrowGap={16}
        teamName={teamName}
        title={data.title}
        subtitle={formatLongDate(dayKeyOf(new Date(data.startsAt), zone))}
      />
      <InfoCard title={shiftDetailCopy.status.title} body={statusBody} testID="shift-status" />
      <InfoCard
        title={formatRange(new Date(data.startsAt), new Date(data.endsAt), zone)}
        body={[place, data.breakMinutes !== null ? shiftDetailCopy.break(data.breakMinutes) : null].filter(Boolean).join('\n')}
        testID="shift-time"
      />
      {coworkers.length > 0 ? (
        <InfoCard
          title={shiftDetailCopy.workingWith}
          body={coworkers.map((s) => `${s.assignee!.name} · ${s.area ?? s.title}`).join('\n')}
          testID="shift-coworkers"
        />
      ) : null}
      {data.note ? <InfoCard title={shiftDetailCopy.note} body={data.note} testID="shift-note" /> : null}
      <Spacer />
      {canEdit ? (
        <>
          <Button
            label={shiftDetailCopy.edit}
            variant="secondary"
            disabled={!online}
            onPress={() => router.push({ pathname: '/shift/[shiftId]/edit', params: { shiftId: data.id } })}
            testID="shift-edit"
          />
          <Button
            label={shiftDetailCopy.delete}
            variant="danger"
            disabled={!online}
            onPress={() => router.push({ pathname: '/shift/[shiftId]/delete', params: { shiftId: data.id } })}
            testID="shift-delete"
          />
        </>
      ) : null}
      <Button label={shiftDetailCopy.notFound.back} variant="secondary" onPress={() => router.dismissTo('/')} testID="shift-back" />
    </Screen>
  );
}
