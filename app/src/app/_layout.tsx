import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { queryClient, restoreSession, settingsPrefetchSettled, wireQueryManagers } from '../services';
import { useThemeSetting } from '../settings/useSettings';
import { useSessionStore } from '../state/sessionStore';
import { fontFiles, ThemePreferenceProvider, useColors, useIsDark } from '../theme';
import { FocusSinkProvider } from '../ui/FocusSink';
import { LaunchGate } from '../ui/LaunchGate';

void SplashScreen.preventAutoHideAsync();

/** The person's theme setting (from the server) for everything below; 'system' until it is known and whenever nobody is signed in. */
function ThemeFromSettings({ children }: { children: ReactNode }) {
  return <ThemePreferenceProvider preference={useThemeSetting()}>{children}</ThemePreferenceProvider>;
}

/**
 * The launch screen also waits for the first settings answer of a signed-in session, so the first frame is already in the person's theme (no flash from the
 * device's colours to a saved dark). It waits for the request, not for success: offline, a refused or a slow request ends it (the request has no retries and the
 * API client's own timeout), and the app then starts on the device's colours.
 */
function useSettingsSettled(status: string): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (status === 'restoring') return;
    let alive = true;
    void settingsPrefetchSettled().then(() => alive && setSettled(true));
    return () => {
      alive = false;
    };
  }, [status]);
  return settled;
}

function RootContent() {
  const colors = useColors();
  const isDark = useIsDark();
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const status = useSessionStore((s) => s.status);
  const settingsSettled = useSettingsSettled(status);

  useEffect(() => {
    const unwire = wireQueryManagers();
    // The session is checked with the server before either side is shown. If anything unexpected escapes, show sign-in.
    restoreSession().catch(() => useSessionStore.getState().setSignedOut());
    return unwire;
  }, []);

  // A font that fails to load falls back to the system font rather than blocking the app.
  const ready = (fontsLoaded || fontError !== null) && status !== 'restoring' && settingsSettled;

  return (
    <LaunchGate ready={ready} onShown={() => void SplashScreen.hideAsync()}>
      {/* The bar's icons follow the colours in use, which may be the person's own choice rather than the device's. */}
      <StatusBar style={isDark ? 'light' : 'dark'} />
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
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {/* The launch animation covers the restore. The native splash is hidden once its first frame is on screen, so the two meet without a flash. */}
        <ThemeFromSettings>
          <RootContent />
        </ThemeFromSettings>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
