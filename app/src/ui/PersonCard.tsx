import { View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Text } from './Text';

interface Props {
  title: string;
  caption: string;
  /** Figma "Email not sent · Staff" is Caption in the danger colour (294:3986). */
  captionTone?: 'muted' | 'danger';
  testID?: string;
}

/** Rota Member row (Figma 5:55, "Teammate" 32:1312): a white card with a bottom border, the name in Label and the role or state in Caption. */
export function PersonCard({ title, caption, captionTone = 'muted', testID }: Props) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${title}. ${caption}`}
      style={{
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        borderRadius: radius[20],
        padding: space[16],
        gap: space[8],
      }}
    >
      <Text variant="label">{title}</Text>
      <Text variant="caption" tone={captionTone}>
        {caption}
      </Text>
    </View>
  );
}
