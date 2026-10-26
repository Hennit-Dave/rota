import { z } from 'zod';
import { CANONICAL_UUID } from '../db/shard.js';
import type { ShiftsConfig } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A UUID in canonical lowercase form: shardFor() refuses anything else, and an exception there would be a 500. */
const uuid = z.string().regex(CANONICAL_UUID);

/**
 * The cross-field rules for a shift's times, shared by create (through Zod) and by an update once it is merged with the stored shift (in the
 * service): the end is after the start, and the break fits inside the shift. No invented number: the break's ceiling is the shift's own length.
 */
export function timesProblem(v: { startsAt: Date; endsAt: Date; breakMinutes?: number | null }): { path: string; code: string; max?: number } | null {
  if (v.endsAt.getTime() <= v.startsAt.getTime()) return { path: 'endsAt', code: 'must_be_after_start' };
  const minutes = Math.floor((v.endsAt.getTime() - v.startsAt.getTime()) / 60_000);
  if (v.breakMinutes != null && v.breakMinutes > minutes) return { path: 'breakMinutes', code: 'break_too_long', max: minutes };
  return null;
}

/**
 * Request schemas for the shift routes (security.md: the whole request, params, query and body). Every object is strict. Instants are ISO-8601 with an
 * explicit offset or `Z` (a bare local time is refused: it would silently mean the server's time zone). They become Dates at millisecond precision,
 * which is exactly what the timestamptz(3) columns store.
 */
export function createShiftSchemas(config: ShiftsConfig) {
  const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
  const title = z.string().trim().min(1).max(config.titleMax);
  const area = z.string().trim().min(1).max(config.areaMax);
  const note = z.string().trim().min(1).max(config.noteMax);
  const breakMinutes = z.number().int().min(0);

  const teamParams = z.strictObject({ teamId: uuid });
  const shiftParams = z.strictObject({ teamId: uuid, shiftId: uuid });

  /** `from` is inclusive, `to` exclusive. A shift is returned when it overlaps that window. */
  const list = z
    .strictObject({
      from: instant,
      to: instant,
      mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    })
    .superRefine((q, ctx) => {
      if (!(q.from instanceof Date) || !(q.to instanceof Date)) return; // an unparseable one already has its own error
      if (q.to.getTime() <= q.from.getTime()) {
        ctx.addIssue({ code: 'custom', path: ['to'], params: { rota: 'must_be_after_start' } });
      } else if (q.to.getTime() - q.from.getTime() > config.maxRangeDays * DAY_MS) {
        ctx.addIssue({ code: 'custom', path: ['to'], params: { rota: 'range_too_long', max: config.maxRangeDays } });
      }
    });

  function checkTimes(v: { startsAt: Date; endsAt: Date; breakMinutes?: number | null }, ctx: z.RefinementCtx) {
    // If either instant failed to parse, that field already has its own error; there is nothing to compare.
    if (!(v.startsAt instanceof Date) || !(v.endsAt instanceof Date)) return;
    const problem = timesProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', path: [problem.path], params: { rota: problem.code, ...(problem.max !== undefined ? { max: problem.max } : {}) } });
  }

  const create = z
    .strictObject({
      title,
      area: area.optional(),
      startsAt: instant,
      endsAt: instant,
      breakMinutes: breakMinutes.optional(),
      note: note.optional(),
      assignedUserId: uuid.nullable().optional(),
    })
    .superRefine(checkTimes);

  /**
   * A partial update. Absent = unchanged; `null` clears area, break, note or the assignee. The times are checked here only when BOTH are sent;
   * otherwise the service checks the merged result against the stored shift.
   */
  const update = z
    .strictObject({
      title: title.optional(),
      area: area.nullable().optional(),
      startsAt: instant.optional(),
      endsAt: instant.optional(),
      breakMinutes: breakMinutes.nullable().optional(),
      note: note.nullable().optional(),
      assignedUserId: uuid.nullable().optional(),
    })
    .superRefine((v, ctx) => {
      if (Object.values(v).every((x) => x === undefined)) {
        ctx.addIssue({ code: 'custom', path: [], params: { rota: 'nothing_to_change' } });
        return;
      }
      if (v.startsAt && v.endsAt) checkTimes({ startsAt: v.startsAt, endsAt: v.endsAt, breakMinutes: v.breakMinutes }, ctx);
    });

  return { teamParams, shiftParams, list, create, update, checkTimes };
}

export type ShiftSchemas = ReturnType<typeof createShiftSchemas>;
