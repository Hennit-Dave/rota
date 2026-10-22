import { Stack } from 'expo-router';
import { useColors } from '../../theme';

/** The signed-in side. Only reachable while the session store says signed in (see the root layout's guards). */
export default function AppLayout() {
  const colors = useColors();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
