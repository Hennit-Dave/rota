import { z } from 'zod';
import { isKnownTimeZone } from '../teams/schemas.js';

/**
 * Request schemas for the settings routes (security.md: params, query and body, all strict). A change is ONE field per request
 * (app-state.md): the body is a union of single-key strict objects, so a body with two settings, or none, or an unknown key, is refused.
 * Who the settings belong to is never in the request: it is the signed-in user.
 */

/** The notification types (Dave, 2026-10-28): shift changes, swap updates, billing. Billing is inert until payments exist. */
export const NOTIFICATION_FIELDS = ['notifyShiftChanges', 'notifySwapUpdates', 'notifyBilling'] as const;

/** 'en' only for now: the app has no translations yet (ADR 0024). A new language is one more entry here, plus its translations. */
export const LANGUAGES = ['en'] as const;
export const THEMES = ['system', 'light', 'dark'] as const;

const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** A wall-clock time, "HH:MM", 24-hour. */
const clock = z.string().regex(HH_MM);

const quietHours = z
  .strictObject({ enabled: z.boolean(), start: clock, end: clock })
  // Start equal to end is neither "never" nor "always": it has no meaning, and the database refuses it too.
  .refine((v) => v.start !== v.end, { path: ['end'] });

const timeZone = z.string().refine(isKnownTimeZone);

export const updateBody = z.union([
  z.strictObject({ quietHours }),
  z.strictObject({ timeZone }),
  z.strictObject({ notifyShiftChanges: z.boolean() }),
  z.strictObject({ notifySwapUpdates: z.boolean() }),
  z.strictObject({ notifyBilling: z.boolean() }),
  z.strictObject({ language: z.enum(LANGUAGES) }),
  z.strictObject({ theme: z.enum(THEMES) }),
]);

export type SettingsChange = z.infer<typeof updateBody>;
