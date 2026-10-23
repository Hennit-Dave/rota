/** "new york" finds America/New_York: case, spaces, underscores and slashes do not matter. Order of the list is kept. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s_/]+/g, '');
}

export function filterTimeZones(zones: readonly string[], query: string): readonly string[] {
  const needle = squash(query);
  if (needle === '') return zones;
  return zones.filter((zone) => squash(zone).includes(needle));
}

/**
 * The phone's own time zone as the starting choice, only if it is one of the offered names (a phone may report an older
 * alias the list does not use). Display convenience: the server still validates whatever is sent.
 */
export function defaultTimeZone(zones: readonly string[], resolve: () => string | undefined): string | null {
  let zone: string | undefined;
  try {
    zone = resolve();
  } catch {
    return null;
  }
  return zone !== undefined && zones.includes(zone) ? zone : null;
}

export const deviceTimeZone = (): string | undefined => Intl.DateTimeFormat().resolvedOptions().timeZone;
