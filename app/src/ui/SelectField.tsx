import { Pressable, View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';

interface Props {
  label: string;
  /** The chosen value, or null when nothing is chosen yet (the placeholder shows). */
  value: string | null;
  placeholder: string;
  onPress: () => void;
  error?: string;
  helper?: string;
  disabled?: boolean;
  testID?: string;
}

/**
 * Rota Input used as a select (Figma 8:111): the label above, the same field as TextField with the Chevron down at the end.
 * Pressing it opens a picker; the field itself never takes text.
 */
export function SelectField({ label, value, placeholder, onPress, error, helper, disabled = false, testID }: Props) {
  const colors = useColors();
  return (
    <View style={{ gap: space[8] }}>
      <Text variant="label">{label}</Text>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${value ?? placeholder}${error ? `. ${error}` : ''}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.surface,
          borderColor: error ? colors.danger : colors.border,
          borderWidth: 1,
          borderRadius: radius[12],
          padding: space[16],
          opacity: disabled ? 0.45 : 1,
        }}
      >
        <Text variant="body" tone={value === null ? 'muted' : 'text'} style={{ flex: 1, minWidth: 0 }}>
          {value ?? placeholder}
        </Text>
        <Icon name="chevronDown" size={24} />
      </Pressable>
      {error ? (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: space[4], alignItems: 'flex-start' }}>
          <View style={{ marginTop: 1 }}>
            <Icon name="alert" size={16} />
          </View>
          <Text variant="caption" tone="danger" style={{ flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : helper ? (
        <Text variant="caption" tone="muted">
          {helper}
        </Text>
      ) : null}
    </View>
  );
}
