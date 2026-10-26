import { router } from 'expo-router';
import { BottomNav, type NavDestination } from './BottomNav';

/** The tabs whose screens exist. Swaps is drawn but disabled until the swaps slice. */
const ENABLED: readonly NavDestination[] = ['schedule', 'team', 'settings'];

const HREF = { schedule: '/', team: '/team', settings: '/account' } as const;

/** The bottom bar wired to the app's routes. Moving between tabs replaces the screen, so Back leaves the app instead of walking through tabs. */
export function AppNav({ selected }: { selected: NavDestination }) {
  return (
    <BottomNav
      selected={selected}
      enabled={ENABLED}
      onSelect={(destination) => {
        if (destination === 'swaps') return;
        router.replace(HREF[destination]);
      }}
    />
  );
}
