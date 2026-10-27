import { Pressable, View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type NavDestination = 'schedule' | 'team' | 'swaps' | 'settings';

const ITEMS: ReadonlyArray<{ key: NavDestination; label: string; icon: IconName }> = [
  { key: 'schedule', label: 'Schedule', icon: 'navSchedule' },
  { key: 'team', label: 'Team', icon: 'navTeam' },
  { key: 'swaps', label: 'Swaps', icon: 'navSwaps' },
  { key: 'settings', label: 'Settings', icon: 'navSettings' },
];

interface Props {
  selected: NavDestination;
  /** Destinations whose screens exist. The others are drawn (as in Figma) but disabled until their slice lands. */
  enabled: readonly NavDestination[];
  onSelect: (destination: NavDestination) => void;
  /** Pressing the tab that is already selected. Only a screen that sits ON TOP of a tab (the activity feed opens from Schedule) passes it, to go back to that tab. */
  onReselect?: () => void;
}

/**
 * Bottom navigation (Figma 32:1480): four equal tabs on a white bar, the selected one on mint with the action colour. Swaps and Settings are drawn
 * but disabled until their slices (swaps, settings) build their screens; nothing here decides what a tab opens. Icons are recoloured from the theme.
 */
export function BottomNav({ selected, enabled, onSelect, onReselect }: Props) {
  const colors = useColors();
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius[12], padding: space[12], height: 72 }}
    >
      {ITEMS.map((item) => {
        const active = item.key === selected;
        const available = enabled.includes(item.key);
        const color = active ? colors.action : colors.muted;
        return (
          <Pressable
            key={item.key}
            testID={`nav-${item.key}`}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: active, disabled: !available }}
            disabled={!available || (active && !onReselect)}
            onPress={() => (active ? onReselect?.() : onSelect(item.key))}
            style={{
              flex: 1,
              height: 48,
              borderRadius: radius[12],
              alignItems: 'center',
              justifyContent: 'center',
              gap: space[4],
              backgroundColor: active ? colors.accent : 'transparent',
              opacity: available ? 1 : 0.45,
            }}
          >
            <Icon name={item.icon} size={24} color={color} />
            <Text variant="caption" style={{ color, textAlign: 'center' }}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
