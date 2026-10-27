import { Pressable, View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Text } from '../ui/Text';
import { scheduleCopy } from './shiftCopy';
import type { Shift } from './shiftResponses';
import { formatRange } from './shiftTime';

interface Props {
  shift: Shift;
  timeZone: string;
  /** Owners and Managers see whose shift it is; Staff only ever see their own, so the line would say nothing. */
  showAssignee: boolean;
  onPress: () => void;
  testID?: string;
}

/** Shift card (Figma "Shift card" 7:24): the time range as the heading, the title and area under it, and the status. Pressing it opens the shift. */
export function ShiftCard({ shift, timeZone, showAssignee, onPress, testID }: Props) {
  const colors = useColors();
  const range = formatRange(new Date(shift.startsAt), new Date(shift.endsAt), timeZone);
  const where = shift.area ? `${shift.title} · ${shift.area}` : shift.title;
  const who = showAssignee ? (shift.assignee ? scheduleCopy.assignedTo(shift.assignee.name) : scheduleCopy.openShift) : null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[range, where, who, scheduleCopy.scheduled].filter(Boolean).join('. ')}
      onPress={onPress}
      style={{ backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, borderRadius: radius[20], padding: space[16], gap: space[8] }}
    >
      <Text variant="heading">{range}</Text>
      <Text variant="body">{where}</Text>
      {who ? (
        <Text variant="caption" tone="muted">
          {who}
        </Text>
      ) : null}
      <View style={{ alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: radius[12], paddingHorizontal: space[8], paddingVertical: space[4] }}>
        <Text variant="caption" tone="action">
          {scheduleCopy.scheduled}
        </Text>
      </View>
    </Pressable>
  );
}
