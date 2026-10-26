import { View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Text } from './Text';

/** The empty-state card of the team screens (Figma 103:2521): a Heading and a muted line on a white card. */
export function EmptyCard({ title, body, testID }: { title: string; body: string; testID?: string }) {
  const colors = useColors();
  return (
    <View testID={testID} style={{ backgroundColor: colors.surface, borderRadius: radius[20], padding: space[16], gap: space[8] }}>
      <Text variant="heading">{title}</Text>
      <Text variant="body" tone="muted">
        {body}
      </Text>
    </View>
  );
}
