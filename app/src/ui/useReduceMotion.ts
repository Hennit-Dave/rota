import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The system "reduce motion" setting (Android "Remove animations"), as the Figma Motion page specifies:
 * AccessibilityInfo.isReduceMotionEnabled, kept current through its change event. Defaults to false until it answers.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduce(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}
