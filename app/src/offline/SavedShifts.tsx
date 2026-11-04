import { View } from 'react-native';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { EmptyCard } from '../ui/EmptyCard';
import { StatusBanner } from '../ui/StatusBanner';
import { Text } from '../ui/Text';
import { ShiftCard } from '../shifts/ShiftCard';
import { formatLongDate } from '../shifts/shiftTime';
import { formatLastUpdated, upcomingDays } from './lastUpdated';
import { offlineCopy } from './offlineCopy';
import type { Upcoming } from './upcoming';

interface Props {
  saved: Upcoming;
  now: Date;
  /** True when the phone has no connection; false when it has one but the server could not be reached. */
  offline: boolean;
  onRetry: () => void;
}

/**
 * The schedule when it cannot be loaded and the phone holds a copy (app-state.md). Read-only on purpose: the cards open nothing, and there is no button to
 * create or change anything (nothing is queued offline). "Last updated" is the SERVER's time when it last answered, shown in the team's clock.
 */
export function SavedShifts({ saved, now, offline, onRetry }: Props) {
  const { timeZone } = saved.team;
  const when = formatLastUpdated(saved.asOf, timeZone);
  const days = upcomingDays(saved.shifts, now, timeZone);
  return (
    <>
      <StatusBanner
        tone="warning"
        title={offline ? offlineCopy.offline : offlineCopy.unreachable}
        body={when ? offlineCopy.lastUpdated(when) : undefined}
        testID="saved-shifts-banner"
      />
      {days.length === 0 ? (
        <EmptyCard title={offlineCopy.empty.title} body={offlineCopy.empty.body} testID="saved-shifts-empty" />
      ) : (
        days.map((day) => (
          <View key={day.key} style={{ gap: space[8] }}>
            <Text variant="label">{formatLongDate(day.key)}</Text>
            {day.shifts.map((shift) => (
              <ShiftCard key={shift.id} shift={shift} timeZone={timeZone} showAssignee={false} testID={`saved-shift-${shift.id}`} />
            ))}
          </View>
        ))
      )}
      <Button label={offlineCopy.retry} variant="secondary" onPress={onRetry} testID="saved-shifts-retry" />
    </>
  );
}
