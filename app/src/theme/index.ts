import { createContext, createElement, useContext, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type ColorTokens } from './colors';
import { resolveColors, type ThemePreference } from './resolveColors';

export { palette } from './palette';
export { radius, space, touchSize } from './dimensions';
export { fontFiles, typography, type TypographyVariant } from './typography';
export type { ColorTokens } from './colors';
export { lightColors };
export type { ThemePreference } from './resolveColors';

const ColorsOverride = createContext<ColorTokens | null>(null);
const Preference = createContext<ThemePreference>('system');

/**
 * Forces one set of colours for everything inside it. The signed-out screens use it to stay light: the theme is a per-user server setting
 * (ADR 0024, issue #24), and it cannot exist before anyone has signed in.
 */
export function ColorsOverrideProvider({ colors, children }: { colors: ColorTokens; children: ReactNode }) {
  return createElement(ColorsOverride.Provider, { value: colors }, children);
}

/** The person's own theme choice, from their settings on the server (read in the root layout). Everything below follows it. */
export function ThemePreferenceProvider({ preference, children }: { preference: ThemePreference; children: ReactNode }) {
  return createElement(Preference.Provider, { value: preference }, children);
}

/** The colours to use here: an enclosing override, else the person's theme setting, else the device (`resolveColors`). */
export function useColors(): ColorTokens {
  const override = useContext(ColorsOverride);
  const preference = useContext(Preference);
  const deviceScheme = useColorScheme();
  return resolveColors({ override, preference, deviceScheme });
}

/** Whether the colours in use are the dark ones: for the status bar, whose icons must contrast with the page. */
export function useIsDark(): boolean {
  return useColors() === darkColors;
}
