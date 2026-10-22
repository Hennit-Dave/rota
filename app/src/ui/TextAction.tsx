import { Pressable } from 'react-native';
import { touchSize } from '../theme';
import { Text } from './Text';

interface Props {
  label: string;
  onPress: () => void;
  /** Dimmed and inert, only while a request is loading (Figma note 232:415: "all actions disabled, including links"). */
  disabled?: boolean;
  testID?: string;
}

/** A text link in the action colour (Figma "Text action"): at least 48 px tall, so it is an easy target. */
export function TextAction({ label, onPress, disabled = false, testID }: Props) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: touchSize, justifyContent: 'center', alignSelf: 'flex-start', opacity: disabled ? 0.45 : 1 }}
    >
      <Text variant="label" tone="action">
        {label}
      </Text>
    </Pressable>
  );
}
