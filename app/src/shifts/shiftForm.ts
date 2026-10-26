import { addDays, dayKeyOf, formatTime, parseDayKey, parseTime, zonedInstant } from './shiftTime';
import type { ShiftInput } from './shiftApi';
import type { Shift } from './shiftResponses';
import { shiftFormCopy } from './shiftCopy';

export type ShiftFormField = 'title' | 'date' | 'start' | 'end';
export type ShiftFormErrors = Partial<Record<ShiftFormField, string>>;

export interface ShiftFormValues {
  title: string;
  /** `YYYY-MM-DD`, read on the team's wall clock. */
  date: string;
  /** `HH:MM`, 24-hour. */
  start: string;
  end: string;
  assigneeId: string | null;
}

export const formFieldOrder: readonly ShiftFormField[] = ['title', 'date', 'start', 'end'];

export interface ShiftFormResult {
  errors: ShiftFormErrors;
  /** Set only when there are no errors. */
  startsAt?: Date;
  endsAt?: Date;
}

/**
 * Presence and shape only, run when the button is tapped (the login pattern, Figma note 232:415): everything else (length caps, the overlap, who is on the
 * team) is the server's decision and comes back as an error. The times are read on the TEAM'S wall clock. An end earlier than the start means the shift
 * runs past midnight and ends the next day; an end equal to the start is an error.
 */
export function validateShiftForm(values: ShiftFormValues, timeZone: string): ShiftFormResult {
  const errors: ShiftFormErrors = {};
  if (values.title.trim() === '') errors.title = shiftFormCopy.errors.titleRequired;
  const date = values.date.trim();
  if (!parseDayKey(date)) errors.date = shiftFormCopy.errors.dateInvalid;
  const start = parseTime(values.start);
  const end = parseTime(values.end);
  if (!start) errors.start = shiftFormCopy.errors.timeInvalid;
  if (!end) errors.end = shiftFormCopy.errors.timeInvalid;
  if (errors.date || !start || !end) return { errors };

  const startsAt = zonedInstant(date, start.hour, start.minute, timeZone);
  if (!startsAt) return { errors: { ...errors, date: shiftFormCopy.errors.dateInvalid } };
  const overnight = end.hour * 60 + end.minute < start.hour * 60 + start.minute;
  const endsAt = zonedInstant(overnight ? addDays(date, 1) : date, end.hour, end.minute, timeZone);
  if (!endsAt || endsAt.getTime() <= startsAt.getTime()) return { errors: { ...errors, end: shiftFormCopy.errors.endAfterStart } };
  if (Object.keys(errors).length > 0) return { errors };
  return { errors, startsAt, endsAt };
}

/** The form's starting values for an existing shift, on the team's wall clock. */
export function valuesFromShift(shift: Shift, timeZone: string): ShiftFormValues {
  const start = new Date(shift.startsAt);
  return {
    title: shift.title,
    date: dayKeyOf(start, timeZone),
    start: formatTime(start, timeZone),
    end: formatTime(new Date(shift.endsAt), timeZone),
    assigneeId: shift.assignee?.id ?? null,
  };
}

/** Only what differs from the stored shift, so an edit never overwrites a field the person did not touch (and an unchanged form sends nothing). */
export function changesFrom(shift: Shift, next: { title: string; startsAt: Date; endsAt: Date; assigneeId: string | null }): Partial<ShiftInput> {
  const changes: Partial<ShiftInput> = {};
  if (next.title.trim() !== shift.title) changes.title = next.title.trim();
  if (next.startsAt.toISOString() !== new Date(shift.startsAt).toISOString()) changes.startsAt = next.startsAt.toISOString();
  if (next.endsAt.toISOString() !== new Date(shift.endsAt).toISOString()) changes.endsAt = next.endsAt.toISOString();
  if (next.assigneeId !== (shift.assignee?.id ?? null)) changes.assignedUserId = next.assigneeId;
  return changes;
}
