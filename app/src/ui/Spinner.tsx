import { useEffect } from 'react';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Icon } from './Icon';

/** The Figma spinner (Icon/Spinner), turning once every 0.9 s. Decorative: whoever shows it says what is loading. */
export function Spinner({ size = 20 }: { size?: number }) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rotation);
  }, [rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Icon name="spinner" size={size} />
    </Animated.View>
  );
}
