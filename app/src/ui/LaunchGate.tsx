import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LAUNCH_CYCLE_MS, launchPhase, msUntilHandover } from '../motion/launchPhase';
import { LAUNCH_SCALE } from '../motion/launchMetrics';
import { LAUNCH_FADE_MS } from '../motion/swapTimelines';
import { palette, useColors } from '../theme';
import { ShiftSwapMark } from './ShiftSwapMark';
import { Text } from './Text';
import { useReduceMotion } from './useReduceMotion';

interface Props {
  /** The session has been checked and the fonts are ready: the app can be shown. */
  ready: boolean;
  /** Called once the first launch frame is on screen, so the native splash can be hidden without a flash. */
  onShown: () => void;
  /** The app. Rendered only once `ready`, underneath the overlay, so it is usable the moment the overlay starts to fade. */
  children: ReactNode;
}

/**
 * The launch screen (Figma Motion, Launch). Rules from the spec, implemented in motion/launchPhase.ts and tested:
 * - It plays only while the session restores, one swap and back, on the teal of the native splash.
 * - It never adds waiting: the app is rendered underneath the moment it is ready, and the overlay fades out over
 *   150 ms with touches passing straight through it, so nothing waits for the animation.
 * - If restore is still running after one cycle, it hands over to the Loading mark (the teal fades to the app background so the
 *   teal-and-grey mark can be seen).
 * - With reduce motion on, the mark is static, and Loading shows the static mark with a visible "Loading…" label.
 */
export function LaunchGate({ ready, onShown, children }: Props) {
  const colors = useColors();
  const reduceMotion = useReduceMotion();
  const [cycleDone, setCycleDone] = useState(false);
  const [gone, setGone] = useState(false);
  const opacity = useSharedValue(1);
  const toBackground = useSharedValue(0);

  const phase = launchPhase({ ready, elapsedMs: cycleDone ? LAUNCH_CYCLE_MS : 0 });
  // After the hand-over the Loading mark stays until the overlay is gone, even while it fades.
  const showLoading = cycleDone;

  useEffect(() => {
    const timer = setTimeout(() => setCycleDone(true), msUntilHandover(0));
    return () => clearTimeout(timer);
  }, []);

  // Told to screen readers once, rather than made an accessible element: a full-screen focusable view gets Android's default focus
  // highlight drawn over the whole window (found on the emulator as a uniform 7% dim).
  useEffect(() => {
    if (showLoading) AccessibilityInfo.announceForAccessibility('Loading');
  }, [showLoading]);

  useEffect(() => {
    if (showLoading) toBackground.value = withTiming(1, { duration: LAUNCH_FADE_MS, easing: Easing.bezier(0, 0, 0.2, 1) });
  }, [showLoading, toBackground]);

  useEffect(() => {
    if (phase !== 'done') return;
    opacity.value = withTiming(0, { duration: LAUNCH_FADE_MS, easing: Easing.bezier(0, 0, 0.2, 1) }, (finished) => {
      if (finished) runOnJS(setGone)(true);
    });
  }, [phase, opacity]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  // The teal layer sits on the app background and fades out at the hand-over: a plain cross-fade, with no colour maths to drift.
  const tealStyle = useAnimatedStyle(() => ({ opacity: 1 - toBackground.value }));

  return (
    <View style={{ flex: 1 }}>
      {ready ? children : null}
      {gone ? null : (
        <Animated.View
          pointerEvents="none"
          onLayout={onShown}
          style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }, overlayStyle]}
        >
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.teal }, tealStyle]} />
          {showLoading ? (
            <View style={{ alignItems: 'center', gap: 12 }}>
              <ShiftSwapMark variant="loading" colors={{ top: colors.action, middle: colors.muted, bottom: colors.action }} reduceMotion={reduceMotion} />
              {reduceMotion ? <Text variant="body">Loading…</Text> : null}
            </View>
          ) : (
            <ShiftSwapMark
              variant="launch"
              scale={LAUNCH_SCALE}
              colors={{ top: palette.white, middle: palette.mint, bottom: palette.white }}
              reduceMotion={reduceMotion}
            />
          )}
        </Animated.View>
      )}
    </View>
  );
}
