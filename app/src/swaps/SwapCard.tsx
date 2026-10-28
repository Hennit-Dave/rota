import { Pressable, View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Text } from '../ui/Text';
import type { Swap } from './swapResponses';
import { statusWord, swapDetail, swapLabel } from './swapText';

interface Props {
  swap: Swap;
  timeZone: string;
  onPress?: () => void;
  testID?: string;
}

/** Swap card (Figma 5:82): the swap in Label, who and when in Caption, and the state in the action colour. Pressing it opens the swap. */
export function SwapCard({ swap, timeZone, onPress, testID }: Props) {
  const colors = useColors();
  const label = swapLabel(swap);
  const detail = swapDetail(swap, timeZone);
  return (
    <Pressable
      testID={testID}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${label}. ${detail}. ${statusWord(swap)}`}
      onPress={onPress}
      style={{ backgroundColor: colors.surface, borderRadius: radius[12], padding: space[16], gap: space[8] }}
    >
      <Text variant="label">{label}</Text>
      <Text variant="caption" tone="muted">
        {detail}
      </Text>
      <View>
        <Text variant="label" tone="action">
          {statusWord(swap)}
        </Text>
      </View>
    </Pressable>
  );
}
