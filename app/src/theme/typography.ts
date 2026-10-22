import {
  DMSans_400Regular,
  DMSans_600SemiBold,
} from '@expo-google-fonts/dm-sans';
import { Manrope_600SemiBold, Manrope_700Bold } from '@expo-google-fonts/manrope';

/**
 * Mirrors the Figma text styles Rota/Display, Title, Heading, Body, Label and Caption.
 * On Android the weight is part of the font file, so each style names one file and sets no fontWeight.
 */
export const fontFiles = {
  Manrope_700Bold,
  Manrope_600SemiBold,
  DMSans_400Regular,
  DMSans_600SemiBold,
};

export interface TextStyleToken {
  fontFamily: keyof typeof fontFiles;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

export const typography = {
  display: { fontFamily: 'Manrope_700Bold', fontSize: 36, lineHeight: 44, letterSpacing: 0 },
  title: { fontFamily: 'Manrope_700Bold', fontSize: 28, lineHeight: 36, letterSpacing: 0 },
  heading: { fontFamily: 'Manrope_600SemiBold', fontSize: 20, lineHeight: 28, letterSpacing: 0 },
  body: { fontFamily: 'DMSans_400Regular', fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  label: { fontFamily: 'DMSans_600SemiBold', fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  caption: { fontFamily: 'DMSans_400Regular', fontSize: 12, lineHeight: 18, letterSpacing: 0 },
} as const satisfies Record<string, TextStyleToken>;

export type TypographyVariant = keyof typeof typography;
