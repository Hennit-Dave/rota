import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { useShiftsRange } from '../../../shifts/useShifts';
import { swapSelectCopy } from '../../../swaps/swapCopy';
import { shiftOptionLabel } from '../../../swaps/swapText';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { OptionSheet } from '../../../ui/OptionSheet';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';
import { SelectField } from '../../../ui/SelectField';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';

/**
 * Request a swap (Figma swap-select 8:316): pick one of your own upcoming shifts and the teammate's shift you would take. The lists come from the schedule
 * endpoint (the next 41 days, under the server's 42-day cap); they only narrow what is offered. Whether a pair is allowed is the server's decision, and it
 * answers with the reason.
 */
export default function NewSwapScreen() {
  return <NewSwap />;
}

const DAY = 24 * 60 * 60 * 1000;

function NewSwap() {
  const { userId, teamId, teamName, timeZone } = useScheduleContext();
  const [now] = useState(() => new Date());
  const range = useMemo(() => ({ from: now, to: new Date(now.getTime() + 41 * DAY) }), [now]);
  const shifts = useShiftsRange(userId, timeZone ? teamId : null, range, false);
  const [offeredId, setOfferedId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'mine' | 'theirs' | null>(null);
  const zone = timeZone ?? 'UTC';

  const upcoming = (shifts.data ?? []).filter((s) => Date.parse(s.startsAt) > now.getTime());
  const mine = upcoming.filter((s) => s.assignee?.id === userId);
  const theirs = upcoming.filter((s) => s.assignee !== null && s.assignee.id !== userId);
  const label = (id: string | null, list: typeof upcoming, withPerson: boolean) => {
    const s = list.find((x) => x.id === id);
    return s ? shiftOptionLabel(s, zone, withPerson) : null;
  };

  const loading = !shifts.data && !shifts.isError;
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={swapSelectCopy.title} subtitle={swapSelectCopy.subtitle} />
      {shifts.isError ? <StatusBanner tone="error" title={swapSelectCopy.loadFailed} testID="swap-select-error" /> : null}
      {loading ? (
        <Text variant="caption" tone="muted">
          {swapSelectCopy.loading}
        </Text>
      ) : null}
      {shifts.data && mine.length === 0 ? <StatusBanner tone="info" title={swapSelectCopy.noneOfYours} testID="swap-none-mine" /> : null}
      {shifts.data && mine.length > 0 && theirs.length === 0 ? <StatusBanner tone="info" title={swapSelectCopy.noneOfTheirs} testID="swap-none-theirs" /> : null}
      <SelectField
        label={swapSelectCopy.yourShift}
        value={label(offeredId, mine, false)}
        placeholder={swapSelectCopy.yourPlaceholder}
        onPress={() => setSheet('mine')}
        disabled={mine.length === 0}
        testID="swap-select-mine"
      />
      <SelectField
        label={swapSelectCopy.theirShift}
        value={label(requestedId, theirs, true)}
        placeholder={swapSelectCopy.theirPlaceholder}
        onPress={() => setSheet('theirs')}
        disabled={theirs.length === 0}
        testID="swap-select-theirs"
      />
      <Spacer />
      <Button
        label={swapSelectCopy.review}
        disabled={!offeredId || !requestedId}
        onPress={() => router.push({ pathname: '/swaps/confirm', params: { offeredId: offeredId!, requestedId: requestedId! } })}
        testID="swap-review"
      />
      <OptionSheet
        visible={sheet === 'mine'}
        title={swapSelectCopy.yourSheet}
        options={mine.map((s) => ({ value: s.id, label: shiftOptionLabel(s, zone, false) }))}
        selected={offeredId}
        onSelect={(id) => {
          setOfferedId(id);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <OptionSheet
        visible={sheet === 'theirs'}
        title={swapSelectCopy.theirSheet}
        options={theirs.map((s) => ({ value: s.id, label: shiftOptionLabel(s, zone, true) }))}
        selected={requestedId}
        onSelect={(id) => {
          setRequestedId(id);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
    </Screen>
  );
}
