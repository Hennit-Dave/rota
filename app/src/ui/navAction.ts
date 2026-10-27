import type { NavDestination } from './BottomNav';

/**
 * How a tab press moves through the stack. Schedule is the root of the signed-in side, the others sit on top of it:
 * - to Schedule: pop back to it (`dismissTo`), so Back from any tab ends at Schedule and one more Back leaves the app;
 * - from Schedule to another tab: push it, so Back returns to Schedule;
 * - between two other tabs: replace, so Back does not walk through every tab visited.
 */
export type NavAction = 'dismissTo' | 'push' | 'replace';

export function navAction(from: NavDestination, to: NavDestination): NavAction {
  if (to === 'schedule') return 'dismissTo';
  return from === 'schedule' ? 'push' : 'replace';
}
