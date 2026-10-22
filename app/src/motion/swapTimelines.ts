/**
 * The Shift-swap mark from the Figma Motion page (261:2), as data: three bars that trade places like shifts on a rota.
 * Pure TypeScript, no React Native, so the numbers are unit-tested against the Figma spec.
 *
 * Geometry is in "units of the 144 x 96 mark" (Motion 261:10): row 1 is (0, 0), row 2 is (32, 34), row 3 is (0, 68), and a bar keeps its
 * size and moves to another bar's row. Each variant is that geometry times a scale (launch 1.25 = 180 x 120, loading and empty 0.5 = 72 x 48,
 * success 0.75 = 108 x 72), which reproduces every position and size the Figma frames list.
 */
export type BarName = 'top' | 'middle' | 'bottom';
export type Row = 1 | 2 | 3;
export type Arrangement = Record<BarName, Row>;
export type SwapVariant = 'launch' | 'loading' | 'success' | 'empty';

export const MARK_UNITS = { width: 144, height: 96 } as const;
export const BAR_NAMES: readonly BarName[] = ['top', 'middle', 'bottom'];
const BAR_UNITS: Record<BarName, { width: number; height: number }> = {
  top: { width: 112, height: 28 },
  middle: { width: 112, height: 28 },
  bottom: { width: 72, height: 28 },
};
const ROW_UNITS: Record<Row, { x: number; y: number }> = { 1: { x: 0, y: 0 }, 2: { x: 32, y: 34 }, 3: { x: 0, y: 68 } };

/** The logo arrangement: bar-top, bar-middle, bar-bottom (Motion 261:13). */
export const LOGO: Arrangement = { top: 1, middle: 2, bottom: 3 };

export type MoveName = 'A' | 'B' | 'undoB' | 'undoA';
/** Where every bar is after each move (Motion 261:11, 261:12, 261:14). Swapped arrangement = bar-middle, bar-bottom, bar-top. */
const AFTER_MOVE: Record<MoveName, Arrangement> = {
  A: { top: 2, middle: 1, bottom: 3 },
  B: { top: 3, middle: 1, bottom: 2 },
  undoB: { top: 2, middle: 1, bottom: 3 },
  undoA: LOGO,
};

/** ease in-out, cubic-bezier(0.4, 0, 0.2, 1) is the default; `out` is the softer landing, cubic-bezier(0, 0, 0.2, 1) (Motion 261:17, 262:39). */
export type EasingName = 'inOut' | 'out';
export const EASING_POINTS: Record<EasingName, readonly [number, number, number, number]> = {
  inOut: [0.4, 0, 0.2, 1],
  out: [0, 0, 0.2, 1],
};

export type Step = { kind: 'move'; move: MoveName; ms: number; easing: EasingName } | { kind: 'wait'; ms: number };

const move = (name: MoveName, ms: number, easing: EasingName = 'inOut'): Step => ({ kind: 'move', move: name, ms, easing });
const wait = (ms: number): Step => ({ kind: 'wait', ms });

export interface Timeline {
  /** Waits this long before the first step (Motion 262:105: the empty state starts 300 ms after the screen appears). */
  startDelayMs: number;
  steps: readonly Step[];
  /** Repeats until told to stop (Loading). It always ends on the logo arrangement, so the repeat is seamless. */
  loop: boolean;
}

export const TIMELINES: Record<SwapVariant, Timeline> = {
  // Move A 250, gap 20, Move B 250, hold 20 (swap = 540); Undo B 250, gap 20, Undo A 250, hold 20 (back = 540). Motion 261:76, 261:77.
  launch: {
    startDelayMs: 0,
    loop: false,
    steps: [move('A', 250), wait(20), move('B', 250), wait(20), move('undoB', 250), wait(20), move('undoA', 250), wait(20)],
  },
  // Rest 600, Move A 500, gap 150, Move B 500, then rest 600, Undo B 500, gap 150, Undo A 500. Loop 3.5 s. Motion 261:129-131.
  loading: {
    startDelayMs: 0,
    loop: true,
    steps: [wait(600), move('A', 500), wait(150), move('B', 500), wait(600), move('undoB', 500), wait(150), move('undoA', 500)],
  },
  // Move A 400 ease in-out, gap 100, Move B 400 ease-out, then stay settled: never moves back, never loops. Motion 262:39.
  success: { startDelayMs: 0, loop: false, steps: [move('A', 400), wait(100), move('B', 400, 'out')] },
  // After 300 ms: A 400, gap 100, B 400, hold 150, Undo B 400, gap 100, Undo A 400 (about 2 s). Plays once. Motion 262:105.
  empty: {
    startDelayMs: 300,
    loop: false,
    steps: [move('A', 400), wait(100), move('B', 400), wait(150), move('undoB', 400), wait(100), move('undoA', 400)],
  },
};

/** The launch overlay fades into the app over 150 ms, ease-out (Motion 261:78). It never delays anything: touches pass through it. */
export const LAUNCH_FADE_MS = 150;

export const VARIANT_SCALE: Record<SwapVariant, number> = { launch: 1.25, loading: 0.5, success: 0.75, empty: 0.5 };

export function totalMs(steps: readonly Step[]): number {
  return steps.reduce((sum, step) => sum + step.ms, 0);
}

/** Every bar's row after each step; a wait leaves the arrangement as it was. Entry 0 is the starting arrangement. */
export function arrangements(steps: readonly Step[]): Arrangement[] {
  const out: Arrangement[] = [LOGO];
  for (const step of steps) {
    const previous = out[out.length - 1] ?? LOGO;
    out.push(step.kind === 'move' ? AFTER_MOVE[step.move] : previous);
  }
  return out;
}

/** What reduce motion shows (Motion 261:22): the logo arrangement, except success, which shows the settled swapped arrangement. */
export function staticArrangement(variant: SwapVariant): Arrangement {
  return variant === 'success' ? AFTER_MOVE.B : LOGO;
}

/** A bar's box, in dp, for a variant: top-left from its row, size from the bar, both times the variant's scale. */
export function barBox(variant: SwapVariant, bar: BarName, row: Row, scale: number = VARIANT_SCALE[variant]) {
  const origin = ROW_UNITS[row];
  const size = BAR_UNITS[bar];
  return { x: origin.x * scale, y: origin.y * scale, width: size.width * scale, height: size.height * scale };
}

export function markSize(scale: number) {
  return { width: MARK_UNITS.width * scale, height: MARK_UNITS.height * scale };
}
