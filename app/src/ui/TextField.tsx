import { useState, type ComponentRef, type Ref } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { radius, space, typography, useColors } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';

/** What a screen holds to move focus to a field (Figma note 232:415: "focus is handled in code"). */
export type TextFieldHandle = ComponentRef<typeof TextInput>;

interface Props
  extends Pick<
    TextInputProps,
    | 'value'
    | 'onChangeText'
    | 'placeholder'
    | 'autoCapitalize'
    | 'autoComplete'
    | 'autoCorrect'
    | 'keyboardType'
    | 'returnKeyType'
    | 'onSubmitEditing'
    | 'textContentType'
    | 'testID'
  > {
  label: string;
  error?: string;
  helper?: string;
  /** A password field: hidden by default, with the show/hide control from Figma (Icon/Eye, Icon/Eye off). */
  secure?: boolean;
  disabled?: boolean;
  inputRef?: Ref<TextFieldHandle>;
}

/**
 * Rota Input (Figma 5:26): label above the field, never inside it. States: default, focused (action border), error
 * (danger border and an alert row), disabled (45%). The field never blocks paste and sets the autofill hints, so
 * password managers work (NIST SP 800-63B-4 3.1.1.2, ADR 0005).
 */
export function TextField({ label, error, helper, secure = false, disabled = false, inputRef, ...input }: Props) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const borderColor = error ? colors.danger : focused ? colors.action : colors.border;

  return (
    <View style={{ gap: space[8] }}>
      <Text variant="label">{label}</Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.surface,
          borderColor,
          borderWidth: 1,
          borderRadius: radius[12],
          paddingHorizontal: space[16],
          paddingVertical: space[16],
          opacity: disabled ? 0.45 : 1,
        }}
      >
        <TextInput
          {...input}
          ref={inputRef}
          editable={!disabled}
          secureTextEntry={secure && !revealed}
          placeholderTextColor={colors.muted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          importantForAutofill="yes"
          // The label is read first; an error is appended so a screen reader hears what is wrong with this field.
          accessibilityLabel={error ? `${label}. ${error}` : label}
          style={[typography.body, { flex: 1, minWidth: 0, color: colors.text, padding: 0, includeFontPadding: false }]}
        />
        {secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            disabled={disabled}
            onPress={() => setRevealed((value) => !value)}
            // A 24 px icon with 12 px around it is a 48 px target; the negative margin keeps the field's padding as designed.
            style={{ margin: -space[12], marginLeft: space[4], padding: space[12] }}
          >
            <Icon name={revealed ? 'eyeOff' : 'eye'} size={24} />
          </Pressable>
        ) : null}
      </View>
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
