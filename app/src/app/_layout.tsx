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
import { LaunchGate } from '../ui/LaunchGate';

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

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {/* The launch animation covers the restore. The native splash is hidden once its first frame is on screen, so the two meet without a flash. */}
        <LaunchGate ready={ready} onShown={() => void SplashScreen.hideAsync()}>
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
              {/* An invite link opens here whether or not anyone is signed in (ADR 0017). Sign in and Create account open on top of it. */}
              <Stack.Screen name="invite/[token]" />
              <Stack.Screen name="invite/index" />
              {/* Magic-link and reset links open here too (ADR 0020). Opening one consumes nothing; the button on the screen does. */}
              <Stack.Screen name="magic/[token]" />
              <Stack.Screen name="magic/index" />
              <Stack.Screen name="reset/[token]" />
              <Stack.Screen name="reset/index" />
              {/* Development-only check screens, reachable from either side. */}
              <Stack.Screen name="dev-api" />
              <Stack.Screen name="dev-check" />
            </Stack>
          </FocusSinkProvider>
        </LaunchGate>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
