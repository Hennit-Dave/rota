import { View } from 'react-native';
import { radius, space, useColors } from '../theme';

/** A grey-green placeholder the size of one person card (Figma loading frame 292:610): 16 + 20 + 8 + 18 + 16. Decorative, hidden from screen readers. */
export function SkeletonBlock({ testID }: { testID?: string }) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ backgroundColor: colors.border, borderRadius: radius[20], height: space[16] * 2 + 20 + space[8] + 18 }}
    />
  );
}
