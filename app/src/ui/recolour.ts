import type { ColorTokens } from '../theme/colors';

/**
 * Replaces every stroke colour in an icon's artwork with `color`. Only the strokes change; the drawing is untouched. Its own file so it can be tested
 * without a renderer.
 */
export function recolour(xmlSource: string, color: string): string {
  return xmlSource.replace(/stroke="#[0-9A-Fa-f]{3,8}"/g, `stroke="${color}"`);
}

/**
 * The Figma artwork is drawn with the LIGHT token colours baked in (ink, red, amber, teal, muted). This swaps each for the same token's colour in the
 * theme in use, so an icon follows light and dark by itself: in light every stroke maps to itself (nothing changes), in dark the ink stroke becomes the
 * dark text colour, and so on. A stroke that matches no token is left as it is. Where two tokens share a light colour the first wins (action and success
 * are both teal in both themes).
 */
export function themeStrokes(xmlSource: string, light: ColorTokens, current: ColorTokens): string {
  const map = new Map<string, string>();
  for (const key of Object.keys(light) as Array<keyof ColorTokens>) {
    const from = light[key].toUpperCase();
    if (!map.has(from)) map.set(from, current[key]);
  }
  return xmlSource.replace(/stroke="(#[0-9A-Fa-f]{3,8})"/g, (whole, hex: string) => {
    const to = map.get(hex.toUpperCase());
    // Same colour (only the letter case differs, as in light): leave the artwork exactly as drawn.
    return to === undefined || to.toUpperCase() === hex.toUpperCase() ? whole : `stroke="${to}"`;
  });
}
