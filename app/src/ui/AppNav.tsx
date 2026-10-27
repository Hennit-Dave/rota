import { router } from 'expo-router';
import { BottomNav, type NavDestination } from './BottomNav';
import { navAction } from './navAction';

/** The tabs whose screens exist. */
const ENABLED: readonly NavDestination[] = ['schedule', 'team', 'swaps', 'settings'];

const HREF = { schedule: '/', team: '/team', swaps: '/swaps', settings: '/account' } as const;

/** The bottom bar wired to the app's routes. How a press moves through the stack is `navAction` (Schedule is the root; Back from a tab returns to it). */
export function AppNav({ selected, onReselect }: { selected: NavDestination; onReselect?: () => void }) {
  return (
    <BottomNav
      selected={selected}
      enabled={ENABLED}
      onReselect={onReselect}
      onSelect={(destination) => {
        const action = navAction(selected, destination);
        if (action === 'dismissTo') router.dismissTo(HREF[destination]);
        else if (action === 'push') router.push(HREF[destination]);
        else router.replace(HREF[destination]);
      }}
    />
  );
}
