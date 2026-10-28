import { darkColors, lightColors, type ColorTokens } from './colors';

/** The per-user theme setting (ADR 0024): follow the device, or always light, or always dark. */
export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * Which colours a screen uses. An enclosing override (the signed-out side, which stays light because the setting does not exist before sign-in, issue
 * #24) always wins; then the person's own choice; 'system' follows the device. Its own file so it can be tested without a renderer.
 */
export function resolveColors(input: { override: ColorTokens | null; preference: ThemePreference; deviceScheme: string | null | undefined }): ColorTokens {
  if (input.override) return input.override;
  if (input.preference === 'light') return lightColors;
  if (input.preference === 'dark') return darkColors;
  return input.deviceScheme === 'dark' ? darkColors : lightColors;
}
