/**
 * Shift settings (ADR 0021). 42 days is the calendar range cap Dave approved on 2026-10-26: six weeks, which covers a month grid. The text sizes only
 * bound the request (the same reason as the team name cap); they are chosen, not measured. An env var overrides the range; a set-but-invalid value
 * stops the server, as for every other setting.
 */
type Env = Record<string, string | undefined>;

export interface ShiftsConfig {
  /** The longest `from`..`to` a calendar request may ask for. */
  maxRangeDays: number;
  titleMax: number;
  areaMax: number;
  noteMax: number;
}

export function loadShiftsConfig(env: Env = process.env): ShiftsConfig {
  const raw = env.SHIFTS_MAX_RANGE_DAYS;
  let maxRangeDays = 42;
  if (raw !== undefined && raw !== '') {
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`SHIFTS_MAX_RANGE_DAYS must be a positive integer, got "${raw}"`);
    maxRangeDays = Number(raw);
    if (!Number.isSafeInteger(maxRangeDays)) throw new Error('SHIFTS_MAX_RANGE_DAYS is too large');
  }
  return { maxRangeDays, titleMax: 100, areaMax: 100, noteMax: 500 };
}
