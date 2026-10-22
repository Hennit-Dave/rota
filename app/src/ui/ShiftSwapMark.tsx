import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {
  BAR_NAMES,
  EASING_POINTS,
  LOGO,
  TIMELINES,
  VARIANT_SCALE,
  arrangements,
  barBox,
  markSize,
  staticArrangement,
  type BarName,
  type SwapVariant,
} from '../motion/swapTimelines';

export interface BarColors {
  top: string;
  middle: string;
  bottom: string;
}

interface Props {
  variant: SwapVariant;
  /** Bar colours, from the tokens. Launch is white and mint on teal; the others are action and muted on the background (Figma 261:27, 261:106). */
  colors: BarColors;
  /** Overrides the variant's Figma scale, for the launch mark that has to match the native splash. */
  scale?: number;
  /** No movement: show the static arrangement instead (Motion 261:19). The caller reads AccessibilityInfo; this stays a pure prop. */
  reduceMotion?: boolean;
  /** Stop and hold the logo arrangement, for example when Loading ends (Motion 261:131: stop on a rest). */
  playing?: boolean;
}

function ease(name: 'inOut' | 'out') {
  const [a, b, c, d] = EASING_POINTS[name];
  return Easing.bezier(a, b, c, d);
}

function Bar({ bar, color, ...rest }: Required<Pick<Props, 'variant' | 'reduceMotion' | 'playing'>> & { bar: BarName; color: string; scale: number }) {
  const { variant, scale, reduceMotion, playing } = rest;
  const timeline = TIMELINES[variant];
  const rows = useMemo(() => arrangements(timeline.steps), [timeline]);
  const home = barBox(variant, bar, LOGO[bar], scale);
  const x = useSharedValue(home.x);
  const y = useSharedValue(home.y);

  useEffect(() => {
    cancelAnimation(x);
    cancelAnimation(y);
    if (reduceMotion || !playing) {
      const resting = barBox(variant, bar, reduceMotion ? staticArrangement(variant)[bar] : LOGO[bar], scale);
      x.value = resting.x;
      y.value = resting.y;
      return;
    }
    x.value = home.x;
    y.value = home.y;
    // One timed segment per step, so every bar stays in step: a moving bar glides to its next row, a still bar holds for the same time.
    const xs = timeline.steps.map((step, i) => {
      const target = barBox(variant, bar, rows[i + 1]?.[bar] ?? LOGO[bar], scale);
      const easing = step.kind === 'move' ? ease(step.easing) : Easing.linear;
      return { x: withTiming(target.x, { duration: step.ms, easing }), y: withTiming(target.y, { duration: step.ms, easing }) };
    });
    const sequenceX = withSequence(...xs.map((segment) => segment.x));
    const sequenceY = withSequence(...xs.map((segment) => segment.y));
    const start = (sequence: typeof sequenceX) => {
      if (timeline.loop) return withRepeat(sequence, -1, false);
      return timeline.startDelayMs > 0 ? withDelay(timeline.startDelayMs, sequence) : sequence;
    };
    x.value = start(sequenceX);
    y.value = start(sequenceY);
    return () => {
      cancelAnimation(x);
      cancelAnimation(y);
    };
    // The geometry and timeline are fixed per variant and scale; reduce motion and playing are the live inputs.
  }, [variant, bar, scale, reduceMotion, playing, rows, timeline, home.x, home.y, x, y]);

  const box = barBox(variant, bar, LOGO[bar], scale);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - box.x }, { translateY: y.value - box.y }] }));
  return (
    <Animated.View
      style={[{ position: 'absolute', left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: 999, backgroundColor: color }, style]}
    />
  );
}

/**
 * The Shift-swap mark (Figma Motion 261:2): the three bars of the app icon, trading places like shifts being swapped.
 * One component for every variant: launch, loading, success and empty (timings and geometry in motion/swapTimelines.ts,
 * unit-tested against the Figma spec). Decorative, so it is hidden from screen readers; the caller labels what is happening.
 */
export function ShiftSwapMark({ variant, colors, scale = VARIANT_SCALE[variant], reduceMotion = false, playing = true }: Props) {
  const size = markSize(scale);
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size.width, height: size.height }}>
      {BAR_NAMES.map((bar) => (
        <Bar key={bar} bar={bar} color={colors[bar]} variant={variant} scale={scale} reduceMotion={reduceMotion} playing={playing} />
      ))}
    </View>
  );
}
