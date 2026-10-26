/**
 * "Only one at a time", decided synchronously. A button's `disabled` only changes after React has rendered again, and two quick taps can both
 * arrive before that happens, so the handler asks the latch first (Figma note 232:415: disabled from the first tap until the request
 * finishes). The first caller gets the latch and every other caller is refused until `release()`.
 */
export interface Latch {
  /** True for the one caller that now holds it; false while someone else does. */
  tryAcquire(): boolean;
  release(): void;
  readonly held: boolean;
}

export function createLatch(): Latch {
  let held = false;
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
    get held() {
      return held;
    },
  };
}
