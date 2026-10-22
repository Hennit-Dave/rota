import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { queryClient, restoreSession, wireQueryManagers } from '../services';
import { useSessionStore } from '../state/sessionStore';
import { fontFiles, useColors } from '../theme';
import { FocusSinkProvider } from '../ui/FocusSink';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colors = useColors();
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
    const unwire = wireQueryManagers();
    // The session is checked with the server before either side is shown. If anything unexpected escapes, show sign-in.
    restoreSession().catch(() => useSessionStore.getState().setSignedOut());
    return unwire;
  }, []);

  // A font that fails to load falls back to the system font rather than blocking the app.
  const ready = (fontsLoaded || fontError !== null) && status !== 'restoring';
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <FocusSinkProvider>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
            {/* Which side exists depends only on the session status; a screen on the other side cannot be reached by link or back. */}
            <Stack.Protected guard={status === 'signedIn'}>
              <Stack.Screen name="(app)" />
            </Stack.Protected>
            <Stack.Protected guard={status === 'signedOut'}>
              <Stack.Screen name="(auth)" />
            </Stack.Protected>
            {/* Development-only check screens, reachable from either side. */}
            <Stack.Screen name="dev-api" />
            <Stack.Screen name="dev-check" />
          </Stack>
        </FocusSinkProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
