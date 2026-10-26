import { Pressable, View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Text } from '../ui/Text';
import { formatLongDate, stripLabel } from './shiftTime';

interface Props {
  /** Seven day keys, Monday first. */
  days: readonly string[];
  selected: string;
  today: string;
  onSelect: (day: string) => void;
}

/** The week strip (Figma 7:13): seven cells, a weekday letter over the day of the month. The chosen day is filled; today is outlined. */
export function WeekStrip({ days, selected, today, onSelect }: Props) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: space[4] }}>
      {days.map((day) => {
        const { letter, day: number } = stripLabel(day);
        const isSelected = day === selected;
        const isToday = day === today;
        return (
          <Pressable
            key={day}
            testID={`day-${day}`}
            accessibilityRole="button"
            accessibilityLabel={`${formatLongDate(day)}${isToday ? ', today' : ''}`}
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(day)}
            style={{
              flex: 1,
              minHeight: 56,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius[12],
              borderWidth: 1,
              borderColor: isSelected || isToday ? colors.action : colors.border,
              backgroundColor: isSelected ? colors.action : colors.surface,
            }}
          >
            <Text variant="caption" style={{ color: isSelected ? colors.onAction : colors.muted }}>
              {letter}
            </Text>
            <Text variant="label" style={{ color: isSelected ? colors.onAction : colors.text }}>
              {number}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
