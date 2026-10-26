/**
 * Replaces every stroke colour in an icon's artwork with `color`. Only the strokes change; the drawing is untouched. Its own file so it can be tested
 * without a renderer.
 */
export function recolour(xmlSource: string, color: string): string {
  return xmlSource.replace(/stroke="#[0-9A-Fa-f]{3,8}"/g, `stroke="${color}"`);
}
