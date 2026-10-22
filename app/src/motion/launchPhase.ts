import { TIMELINES, totalMs } from './swapTimelines';

/** One launch cycle: a swap and the swap back, 540 ms each (Motion 261:76-77). */
export const LAUNCH_CYCLE_MS = totalMs(TIMELINES.launch.steps);

export type LaunchPhase = 'launch' | 'loading' | 'done';

/**
 * The launch rules from the Motion page (263:10), as a pure function so they can be tested:
 * - Never adds waiting time: the moment the session is restored the phase is `done`, wherever the animation is.
 * - Plays only while the session restores: `launch` for one cycle.
 * - If restore is still running after one cycle, hand over to the Loading indicator.
 */
export function launchPhase(input: { ready: boolean; elapsedMs: number }): LaunchPhase {
  if (input.ready) return 'done';
  return input.elapsedMs < LAUNCH_CYCLE_MS ? 'launch' : 'loading';
}

/** How long until the hand-over to Loading, for a timer. */
export function msUntilHandover(elapsedMs: number): number {
  return Math.max(0, LAUNCH_CYCLE_MS - elapsedMs);
}
