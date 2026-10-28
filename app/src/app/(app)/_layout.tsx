import { Stack } from 'expo-router';
import { useMe } from '../../auth/useMe';
import { useSettings } from '../../settings/useSettings';
import { useColors } from '../../theme';

/**
 * The signed-in side. Only reachable while the session store says signed in (see the root layout's guards). It keeps one observer on the user's settings, so
 * they are fetched and refetched whenever the app returns to the foreground on EVERY screen, and the theme (and, later, anything else read from them)
 * follows a change made on another device (brief Requirement 7).
 */
export default function AppLayout() {
  const colors = useColors();
  const me = useMe();
  useSettings(me.data?.id);
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
