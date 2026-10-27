import { View } from 'react-native';
import { radius, space, useColors } from '../theme';

/** Activity item skeleton (Figma 102:648): the card's shape with two grey bars, 78 px tall. Decorative and hidden from screen readers; the list announces "Loading" once. */
export function ActivitySkeleton({ testID }: { testID?: string }) {
  const colors = useColors();
  const bar = (width: number, height: number) => ({ width, height, borderRadius: 6, backgroundColor: colors.border });
  return (
    <View
      testID={testID}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ height: 78, backgroundColor: colors.surface, borderRadius: radius[12], padding: space[16], gap: space[8] }}
    >
      <View style={bar(220, 16)} />
      <View style={bar(140, 12)} />
    </View>
  );
}
