import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ApiError, OfflineError } from '../../api/errors';
import { bannerCopy } from '../../auth/copy';
import { ShiftCard } from '../../shifts/ShiftCard';
import { scheduleCopy } from '../../shifts/shiftCopy';
import { addDays, dayKeyOf, formatLongDate, greetingFor, shiftsOnDay, weekWindow } from '../../shifts/shiftTime';
import { useScheduleContext } from '../../shifts/useScheduleContext';
import { useShiftsRange } from '../../shifts/useShifts';
import { WeekStrip } from '../../shifts/WeekStrip';
import { ColorsOverrideProvider, lightColors, space } from '../../theme';
import { AppNav } from '../../ui/AppNav';
import { Button } from '../../ui/Button';
import { EmptyCard } from '../../ui/EmptyCard';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { SkeletonBlock } from '../../ui/SkeletonBlock';
import { StatusBanner } from '../../ui/StatusBanner';
import { Text } from '../../ui/Text';
import { TextAction } from '../../ui/TextAction';
import { useOnline } from '../../ui/useOnline';

/**
 * Schedule (Figma 04: calendar 7:6 and calendar-staff 102:276, with calendar-loading 10:370, calendar-empty 10:353 and calendar-error 7:174). The week
 * strip picks a day; the shifts of that day come from one request for the whole week (the server caps a range at 42 days). Owners and Managers see
 * every shift of the team and can create one; Staff see their own (`mine`). Which buttons exist comes from the server's `canEditShifts`; the server
 * decides again on every write. Times are the team's wall clock. Light-only for now (issue #24).
 */
export default function ScheduleScreen() {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <Schedule />
    </ColorsOverrideProvider>
  );
}

function Schedule() {
  const online = useOnline();
  const { me, userId, teamId, teams, detail, teamName, timeZone, canEdit } = useScheduleContext();

  // A signed-in person with no team yet goes on to create one.
  const noTeams = teams.data !== undefined && teams.data.length === 0;
  useEffect(() => {
    if (noTeams) router.replace('/create-team');
  }, [noTeams]);

  const zone = timeZone ?? 'UTC';
  const [now] = useState(() => new Date());
  const today = dayKeyOf(now, zone);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? today;
  const week = useMemo(() => weekWindow(selected, zone), [selected, zone]);

  const ready = detail.data !== undefined;
  const shifts = useShiftsRange(userId, ready ? teamId : null, week, !canEdit);
  const dayShifts = shiftsOnDay(shifts.data ?? [], selected, zone);
  const isToday = selected === today;

  const firstName = me.data?.name.split(' ')[0] ?? '';
  const subtitle = !ready
    ? undefined
    : canEdit
      ? scheduleCopy.subtitleManager(formatLongDate(selected), dayShifts.length, isToday)
      : scheduleCopy.subtitleStaff(formatLongDate(selected), dayShifts.length);

  const retryAll = () => {
    void me.refetch();
    void teams.refetch();
    if (teamId !== null) void detail.refetch();
    if (ready) void shifts.refetch();
  };

  const loadFailure = (detail.error ?? shifts.error ?? teams.error ?? me.error) as unknown;
  const failed = !shifts.data && (shifts.isError || detail.isError || teams.isError || me.isError);
  const offline = loadFailure instanceof OfflineError || !online;
  const open = (shiftId: string) => router.push({ pathname: '/shift/[shiftId]', params: { shiftId } });

  const card = (shift: (typeof dayShifts)[number]) => (
    <ShiftCard key={shift.id} shift={shift} timeZone={zone} showAssignee={canEdit} onPress={() => open(shift.id)} testID={`shift-${shift.id}`} />
  );

  let body: React.ReactNode;
  if (shifts.data) {
    const upcoming = isToday ? dayShifts.filter((s) => Date.parse(s.endsAt) > now.getTime()) : [];
    const [next, ...later] = upcoming;
    const earlier = isToday ? dayShifts.filter((s) => Date.parse(s.endsAt) <= now.getTime()) : [];
    body = (
      <>
        {!online ? <StatusBanner tone="warning" title={scheduleCopy.offline} testID="schedule-offline" /> : null}
        <WeekStrip days={week.days} selected={selected} today={today} onSelect={setPicked} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <TextAction label={scheduleCopy.previousWeek} onPress={() => setPicked(addDays(week.days[0]!, -7))} testID="week-previous" />
          <TextAction label={scheduleCopy.nextWeek} onPress={() => setPicked(addDays(week.days[0]!, 7))} testID="week-next" />
        </View>
        {shifts.data.length === 0 ? (
          <EmptyCard title={scheduleCopy.empty.cardTitle} body={scheduleCopy.empty.cardBody} testID="schedule-empty" />
        ) : dayShifts.length === 0 ? (
          <Text variant="body" tone="muted" testID="schedule-day-empty">
            {scheduleCopy.dayEmpty}
          </Text>
        ) : isToday && next ? (
          <>
            <Text variant="label">{canEdit ? scheduleCopy.nextTeam : scheduleCopy.next}</Text>
            {card(next)}
            {later.length > 0 ? <Text variant="caption" tone="muted">{scheduleCopy.later}</Text> : null}
            {later.map(card)}
            {earlier.length > 0 ? <Text variant="caption" tone="muted">{scheduleCopy.earlier}</Text> : null}
            {earlier.map(card)}
          </>
        ) : (
          <>
            <Text variant="label">{canEdit ? scheduleCopy.team : scheduleCopy.yours}</Text>
            {dayShifts.map(card)}
          </>
        )}
      </>
    );
  } else if (failed) {
    const reference = loadFailure instanceof ApiError && loadFailure.requestId ? `${bannerCopy.referencePrefix}${loadFailure.requestId}` : undefined;
    body = (
      <>
        <EmptyCard title={scheduleCopy.error.cardTitle} body={scheduleCopy.error.cardBody} testID="schedule-error" />
        {offline ? (
          <StatusBanner tone="warning" title={scheduleCopy.offline} />
        ) : (
          <StatusBanner tone="error" title={scheduleCopy.error.title} reference={reference} />
        )}
        <Button label={scheduleCopy.error.retry} variant="secondary" onPress={retryAll} testID="schedule-retry" />
      </>
    );
  } else {
    body = (
      <View accessibilityLabel={scheduleCopy.loading.subtitle} testID="schedule-loading" style={{ gap: space[12] }}>
        <SkeletonBlock />
        <SkeletonBlock />
        <SkeletonBlock />
      </View>
    );
  }

  const title = failed && !shifts.data ? scheduleCopy.error.title : !ready ? scheduleCopy.loading.title : scheduleCopy.greeting(greetingFor(now, zone), firstName);
  const header = failed && !shifts.data ? scheduleCopy.error.subtitle : !ready ? scheduleCopy.loading.subtitle : subtitle;

  return (
    <Screen gap={space[12]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={title} subtitle={header} />
      {body}
      {shifts.data && canEdit ? <Button label={scheduleCopy.createShift} onPress={() => router.push('/shift/new')} testID="schedule-create" /> : null}
      {shifts.data ? <Button label={scheduleCopy.viewActivity} variant="secondary" onPress={() => router.push('/activity')} testID="schedule-activity" /> : null}
      <Spacer />
      <AppNav selected="schedule" />
    </Screen>
  );
}
