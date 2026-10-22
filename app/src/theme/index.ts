import { createContext, createElement, useContext, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type ColorTokens } from './colors';

export { palette } from './palette';
export { radius, space, touchSize } from './dimensions';
export { fontFiles, typography, type TypographyVariant } from './typography';
export type { ColorTokens } from './colors';
export { lightColors };

const ColorsOverride = createContext<ColorTokens | null>(null);

/**
 * Forces one set of colours for everything inside it. The signed-out screens use it to stay light: the theme becomes a
 * per-user server setting in the settings slice (issue #24), and it cannot exist before anyone has signed in.
 */
export function ColorsOverrideProvider({ colors, children }: { colors: ColorTokens; children: ReactNode }) {
  return createElement(ColorsOverride.Provider, { value: colors }, children);
}

/** Follows the device setting for now (issue #24), unless an enclosing ColorsOverrideProvider says otherwise. */
export function useColors(): ColorTokens {
  const override = useContext(ColorsOverride);
  const scheme = useColorScheme();
  return override ?? (scheme === 'dark' ? darkColors : lightColors);
}
