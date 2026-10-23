import { z } from 'zod';
import { CANONICAL_UUID } from '../db/shard.js';

/** Our cap on a team name; it only bounds request size and keeps the app's header readable. Approved 2026-10-23. */
export const TEAM_NAME_MAX_LENGTH = 80;

// The runtime's own IANA list. A time zone the server cannot use for shift times is refused here, not later.
const TIME_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

export const teamIdParams = z.strictObject({
  // Canonical lowercase hyphenated only: shardFor() refuses anything else, and an exception there would be a 500.
  teamId: z.string().regex(CANONICAL_UUID),
});

export const createTeamBody = z.strictObject({
  name: z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH),
  timeZone: z.string().refine((tz) => TIME_ZONES.has(tz)),
});
