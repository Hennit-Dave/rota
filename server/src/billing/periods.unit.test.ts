import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorDayOf, dayOfPeriod, daysBetween, periodContaining, periodNumber, periodStart, remainingDays, utcDateOf } from './periods.js';

// money.md: calendar-month anniversaries from the activation day, clamped to the month's last day; the anchor itself is never changed.
test('anchor 31 gives Jan 31, Feb 28, Mar 31, Apr 30, May 31 (a non-leap year)', () => {
  const starts = [0, 1, 2, 3, 4].map((i) => periodStart('2031-01-31', i));
  assert.deepEqual(starts, ['2031-01-31', '2031-02-28', '2031-03-31', '2031-04-30', '2031-05-31']);
  assert.deepEqual([0, 1, 2, 3].map((i) => periodNumber('2031-01-31', i).periodDays), [28, 31, 30, 31]);
});

test('in a leap year February is 29: anchor 31 gives Feb 29 then Mar 31', () => {
  assert.deepEqual([0, 1, 2].map((i) => periodStart('2032-01-31', i)), ['2032-01-31', '2032-02-29', '2032-03-31']);
  assert.equal(periodNumber('2032-01-31', 0).periodDays, 29);
  assert.equal(periodNumber('2031-01-31', 0).periodDays, 28);
});

test('anchors 29 and 30 clamp the same way, and a clamped month does not drag later months back', () => {
  assert.deepEqual([0, 1, 2].map((i) => periodStart('2031-01-30', i)), ['2031-01-30', '2031-02-28', '2031-03-30']);
  assert.deepEqual([0, 1, 2].map((i) => periodStart('2031-01-29', i)), ['2031-01-29', '2031-02-28', '2031-03-29']);
});

test('periods cross the year end', () => {
  assert.deepEqual([0, 1, 2].map((i) => periodStart('2030-11-15', i)), ['2030-11-15', '2030-12-15', '2031-01-15']);
  assert.deepEqual(periodNumber('2030-12-31', 1), { startsOn: '2031-01-31', endsOn: '2031-02-28', periodDays: 28 });
});

test('the anchor day is the UTC day of activation', () => {
  assert.equal(anchorDayOf('2031-01-31'), 31);
  assert.equal(utcDateOf(new Date('2031-03-04T23:30:00-05:00')), '2031-03-05', 'a late evening in New York is already the next day in UTC');
});

test('periodContaining: a date at or after the end belongs to the next period', () => {
  assert.equal(periodContaining('2031-01-31', '2031-02-27').index, 0);
  assert.equal(periodContaining('2031-01-31', '2031-02-28').index, 1, 'the boundary day starts the next period');
  assert.equal(periodContaining('2031-01-31', '2031-03-01').index, 1);
  assert.equal(periodContaining('2031-01-31', '2031-03-30').index, 1);
  assert.equal(periodContaining('2031-01-31', '2031-03-31').index, 2);
  assert.equal(periodContaining('2031-01-31', '2031-01-31').index, 0);
  assert.throws(() => periodContaining('2031-01-31', '2031-01-30'), /before the subscription activated/);
});

test('day of period and remaining days: the day of the change counts (day 1 = first day)', () => {
  const june = periodNumber('2031-06-01', 0); // 30 days
  assert.equal(june.periodDays, 30);
  assert.equal(dayOfPeriod(june, '2031-06-01'), 1);
  assert.equal(remainingDays(june, '2031-06-01'), 30);
  assert.equal(remainingDays(june, '2031-06-11'), 20, 'the brief: the 11th of a 30-day period leaves 20');
  assert.equal(remainingDays(june, '2031-06-21'), 10);
  assert.equal(remainingDays(june, '2031-06-30'), 1);
  assert.throws(() => remainingDays(june, '2031-07-01'), /outside the period/, 'at or after the end is the next period');
  assert.throws(() => remainingDays(june, '2031-05-31'), /outside the period/);
});

test('dates are validated', () => {
  assert.throws(() => daysBetween('2031-02-30', '2031-03-01'), /not a calendar date/);
  assert.throws(() => periodStart('31-01-2031', 1), /not a calendar date/);
  assert.throws(() => periodStart('2031-01-31', -1), /non-negative/);
  assert.equal(daysBetween('2031-01-31', '2031-02-28'), 28);
});
