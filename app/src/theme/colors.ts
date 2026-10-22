import { palette } from './palette';

/** Mirrors the Figma collection "Rota / Colour": semantic names, one alias per mode (Light, Dark). */
export interface ColorTokens {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  action: string;
  onAction: string;
  accent: string;
  danger: string;
  dangerSurface: string;
  warning: string;
  warningSurface: string;
  success: string;
}

export const lightColors: ColorTokens = {
  background: palette.paper,
  surface: palette.white,
  text: palette.ink,
  muted: palette.muted,
  border: palette.line,
  action: palette.teal,
  onAction: palette.white,
  accent: palette.mint,
  danger: palette.red,
  dangerSurface: palette.redPale,
  warning: palette.amber,
  warningSurface: palette.amberPale,
  success: palette.teal,
};

export const darkColors: ColorTokens = {
  background: palette.night,
  surface: palette.surfaceDark,
  text: palette.whiteDark,
  muted: palette.mutedDark,
  border: palette.lineDark,
  action: palette.tealDark,
  onAction: palette.night,
  accent: palette.mintDark,
  danger: palette.redDark,
  dangerSurface: palette.redSurface,
  warning: palette.amberDark,
  warningSurface: palette.amberSurface,
  success: palette.tealDark,
};
