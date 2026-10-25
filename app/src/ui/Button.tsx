import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { radius, space, useColors } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';
import { useReduceMotion } from './useReduceMotion';

interface Props {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'outline';
  /** Spinner and `loadingLabel`; every action on the screen is disabled while loading (Figma note 232:415). */
  loading?: boolean;
  loadingLabel?: string;
  /** Figma "Disabled": only while loading or offline. */
  disabled?: boolean;
  testID?: string;
}

function Spinner() {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rotation);
  }, [rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Icon name="spinner" size={20} />
    </Animated.View>
  );
}

/** Rota Button (Figma 5:12): Primary, Secondary, Disabled and Loading, plus the white outlined "Secondary action" of the team screens (Figma 8:202, "Invite a teammate"). 52 px tall at default text size, and it grows with the font. */
export function Button({ label, onPress, variant = 'primary', loading = false, loadingLabel, disabled = false, testID }: Props) {
  const colors = useColors();
  const reduceMotion = useReduceMotion();
  const inactive = disabled || loading;
  // Disabled uses the secondary look at 45% opacity; Loading keeps the primary look with a spinner.
  const outline = variant === 'outline';
  const quiet = variant === 'secondary' || (disabled && !loading && !outline);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={loading ? (loadingLabel ?? label) : label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: radius[12],
        paddingVertical: space[16],
        paddingHorizontal: space[16],
        backgroundColor: outline ? colors.surface : quiet ? colors.accent : colors.action,
        borderWidth: outline ? 1 : 0,
        borderColor: colors.border,
        opacity: disabled && !loading ? 0.45 : pressed ? 0.85 : 1,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space[8] }}>
        {/* A spinner that does not spin looks frozen (Motion page), so reduce motion shows the label alone. */}
        {loading && !reduceMotion ? <Spinner /> : null}
        <Text variant="label" style={{ color: outline ? colors.text : quiet ? colors.action : colors.onAction, textAlign: 'center' }}>
          {loading ? (loadingLabel ?? label) : label}
        </Text>
      </View>
    </Pressable>
  );
}
