import { Pressable, View } from 'react-native';
import { radius, space, touchSize, useColors } from '../theme';
import { Text } from '../ui/Text';

interface RowProps {
  label: string;
  /** What the setting is now, on the right in the action colour (Figma 108:2624: "22:00 – 07:00", "On", "Light"). */
  value: string;
  onPress: () => void;
  /** This setting's change is on its way: only this row is off (app-state.md); the others stay available. */
  disabled?: boolean;
  /** A switch (On/Off) announces itself as one to screen readers. */
  checked?: boolean;
  testID?: string;
}

/** One row of the "Setting group" (Figma 108:2624): the label, and the value at the end. 48 px tall at least, so it is an easy target. */
export function SettingRow({ label, value, onPress, disabled = false, checked, testID }: RowProps) {
  const isSwitch = checked !== undefined;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={isSwitch ? 'switch' : 'button'}
      accessibilityLabel={`${label}. ${value}`}
      accessibilityState={isSwitch ? { checked, disabled } : { disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: touchSize, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[12], opacity: disabled ? 0.45 : 1 }}
    >
      <Text variant="body" style={{ flexShrink: 1 }}>
        {label}
      </Text>
      <Text variant="label" tone="action">
        {value}
      </Text>
    </Pressable>
  );
}

/** The white card that holds the rows, with its small title (Figma 108:2624). */
export function SettingGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius[12], padding: space[16] }}>
      <Text variant="label">{title}</Text>
      {children}
    </View>
  );
}
