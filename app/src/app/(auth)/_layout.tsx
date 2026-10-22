import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ColorsOverrideProvider, lightColors } from '../../theme';

/** The signed-out side. Light only: the theme is a per-user server setting that cannot exist before sign-in (STATE.md, issue #24). */
export default function AuthLayout() {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: lightColors.background } }} />
    </ColorsOverrideProvider>
  );
}
