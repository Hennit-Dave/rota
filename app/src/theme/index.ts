import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type ColorTokens } from './colors';

export { palette } from './palette';
export { radius, space, touchSize } from './dimensions';
export { fontFiles, typography, type TypographyVariant } from './typography';
export type { ColorTokens } from './colors';

/** Follows the device setting for now. Theme becomes a server-side per-user setting in the settings slice (issue #24). */
export function useColors(): ColorTokens {
  return useColorScheme() === 'dark' ? darkColors : lightColors;
}
