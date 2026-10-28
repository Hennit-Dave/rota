// Billing periods: calendar-month anniversaries from each team's own activation day (money.md). Pure functions over UTC calendar dates.
// A date is a 'YYYY-MM-DD' string (UTC). A period is [startsOn, endsOn): it begins at 00:00 UTC on startsOn and ends at 00:00 UTC on endsOn.
import { BillingInputError } from './plans.js';

export type CalendarDate = string;

export interface Period {
  startsOn: CalendarDate;
  endsOn: CalendarDate;
  /** 28 to 31, read from the period itself. Never a literal 30 in calculations. */
  periodDays: number;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: CalendarDate): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new BillingInputError(`not a calendar date: ${date}`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new BillingInputError(`not a calendar date: ${date}`);
  return { y, m, d };
}

function format(y: number, m: number, d: number): CalendarDate {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10);
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whole days from `from` to `to` (UTC calendar days; negative if `to` is earlier). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** The UTC calendar date of an instant. */
export function utcDateOf(instant: Date): CalendarDate {
  return instant.toISOString().slice(0, 10);
}

/** The billing anchor day (1 to 31): the UTC day of the month the subscription activated on. */
export function anchorDayOf(activationDate: CalendarDate): number {
  return parse(activationDate).d;
}

/**
 * The start of period number `index` (0 = the first period, which starts on the activation date itself). The anchor is never changed by clamping:
 * the day is the anchor day, or the month's last day when the month is shorter. It is computed from the first month, not from the previous
 * period, so a clamped February cannot drag March back to the 28th.
 */
export function periodStart(activationDate: CalendarDate, index: number): CalendarDate {
  if (!Number.isSafeInteger(index) || index < 0) throw new BillingInputError('period index must be a non-negative integer');
  const { y, m, d: anchor } = parse(activationDate);
  const monthIndex = y * 12 + (m - 1) + index;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return format(year, month, Math.min(anchor, daysIn(year, month)));
}

export function periodNumber(activationDate: CalendarDate, index: number): Period {
  const startsOn = periodStart(activationDate, index);
  const endsOn = periodStart(activationDate, index + 1);
  return { startsOn, endsOn, periodDays: daysBetween(startsOn, endsOn) };
}

/** The period that contains `date`, and its index. A date at or after `endsOn` belongs to the next period. */
export function periodContaining(activationDate: CalendarDate, date: CalendarDate): { index: number; period: Period } {
  const activation = parse(activationDate);
  const target = parse(date);
  if (daysBetween(activationDate, date) < 0) throw new BillingInputError('the date is before the subscription activated');
  let index = (target.y - activation.y) * 12 + (target.m - activation.m);
  // The month difference can be one too many (the day falls before this month's anniversary).
  if (periodStart(activationDate, index) > date) index -= 1;
  return { index, period: periodNumber(activationDate, index) };
}

/** Day `d` of the period (day 1 = first day) for a change on `date`: d = daysBetween(start, date) + 1. */
export function dayOfPeriod(period: Period, date: CalendarDate): number {
  if (date < period.startsOn || date >= period.endsOn) throw new BillingInputError(`${date} is outside the period ${period.startsOn} to ${period.endsOn}`);
  return daysBetween(period.startsOn, date) + 1;
}

/** remaining = period_days - d + 1, counting the day of the change (money.md). */
export function remainingDays(period: Period, date: CalendarDate): number {
  return period.periodDays - dayOfPeriod(period, date) + 1;
}
