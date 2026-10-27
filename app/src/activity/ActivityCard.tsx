import { View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Text } from '../ui/Text';

/** Activity item (Figma 5:95): a white card, the change in Label, when and by whom in Caption. One element for screen readers: "<change>. <when and who>". */
export function ActivityCard({ label, detail, testID }: { label: string; detail: string; testID?: string }) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${label}. ${detail}`}
      style={{ backgroundColor: colors.surface, borderRadius: radius[12], padding: space[16], gap: space[8] }}
    >
      <Text variant="label">{label}</Text>
      <Text variant="caption" tone="muted">
        {detail}
      </Text>
    </View>
  );
}
