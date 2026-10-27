import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, dayKeyOf, formatLongDate, formatRange, formatTime, greetingFor, parseDayKey, parseTime, shiftsOnDay, startOfDay, stripLabel, weekOf, weekWindow, zonedInstant } from './shiftTime';

const LAGOS = 'Africa/Lagos'; // UTC+1 all year
const NEW_YORK = 'America/New_York'; // UTC-5 / UTC-4 with daylight saving
const LONDON = 'Europe/London';

test('a day key is the date on the TEAM\'S wall clock, not UTC', () => {
  const lateUtc = new Date('2031-03-04T23:30:00Z');
  assert.equal(dayKeyOf(lateUtc, 'UTC'), '2031-03-04');
  assert.equal(dayKeyOf(lateUtc, LAGOS), '2031-03-05', '00:30 the next day in Lagos');
  assert.equal(dayKeyOf(lateUtc, NEW_YORK), '2031-03-04');
});

test('parseDayKey accepts real calendar dates only', () => {
  assert.deepEqual(parseDayKey('2031-03-04'), { year: 2031, month: 3, day: 4 });
  assert.equal(parseDayKey('2031-02-30'), null);
  assert.equal(parseDayKey('2031-13-01'), null);
  assert.equal(parseDayKey('2031-3-4'), null);
  assert.equal(parseDayKey('tomorrow'), null);
  assert.deepEqual(parseDayKey('2032-02-29'), { year: 2032, month: 2, day: 29 }, 'a leap day');
  assert.equal(parseDayKey('2031-02-29'), null);
});

test('addDays moves whole calendar days across month and year ends', () => {
  assert.equal(addDays('2031-03-31', 1), '2031-04-01');
  assert.equal(addDays('2031-12-31', 1), '2032-01-01');
  assert.equal(addDays('2031-03-01', -1), '2031-02-28');
  assert.equal(addDays('2031-03-04', 0), '2031-03-04');
});

test('zonedInstant: the wall clock of the zone, so 09:00 in Lagos is 08:00 UTC and 09:00 in New York is 14:00 or 13:00 UTC', () => {
  assert.equal(zonedInstant('2031-03-04', 9, 0, LAGOS)!.toISOString(), '2031-03-04T08:00:00.000Z');
  assert.equal(zonedInstant('2031-01-15', 9, 0, NEW_YORK)!.toISOString(), '2031-01-15T14:00:00.000Z', 'winter: UTC-5');
  assert.equal(zonedInstant('2031-07-15', 9, 0, NEW_YORK)!.toISOString(), '2031-07-15T13:00:00.000Z', 'summer: UTC-4');
  assert.equal(zonedInstant('2031-03-04', 24, 0, LAGOS), null);
  assert.equal(zonedInstant('2031-02-30', 9, 0, LAGOS), null);
});

test('zonedInstant across a daylight-saving change: the clock, not a fixed offset, decides', () => {
  // US clocks go forward on 2031-03-09 at 02:00. 12:00 that day is already UTC-4.
  assert.equal(zonedInstant('2031-03-09', 12, 0, NEW_YORK)!.toISOString(), '2031-03-09T16:00:00.000Z');
  assert.equal(zonedInstant('2031-03-08', 12, 0, NEW_YORK)!.toISOString(), '2031-03-08T17:00:00.000Z', 'the day before: UTC-5');
  // UK clocks go forward on 2031-03-30: 09:00 London is 08:00 UTC from then.
  assert.equal(zonedInstant('2031-03-29', 9, 0, LONDON)!.toISOString(), '2031-03-29T09:00:00.000Z');
  assert.equal(zonedInstant('2031-03-31', 9, 0, LONDON)!.toISOString(), '2031-03-31T08:00:00.000Z');
});

test('zonedInstant and wallClock round-trip for every quarter hour of a day, in three zones', () => {
  for (const tz of [LAGOS, NEW_YORK, LONDON]) {
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const hour = Math.floor(minutes / 60);
      const minute = minutes % 60;
      const instant = zonedInstant('2031-06-10', hour, minute, tz)!;
      assert.equal(formatTime(instant, tz), `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, `${tz} ${hour}:${minute}`);
    }
  }
});

test('startOfDay and weekWindow: a week is Monday 00:00 to the next Monday 00:00 on the team\'s clock, 7 days, inside the 42-day cap', () => {
  const w = weekWindow('2031-03-06', LAGOS); // a Thursday
  assert.deepEqual(w.days, ['2031-03-03', '2031-03-04', '2031-03-05', '2031-03-06', '2031-03-07', '2031-03-08', '2031-03-09']);
  assert.equal(w.from.toISOString(), '2031-03-02T23:00:00.000Z', 'Monday 00:00 Lagos is Sunday 23:00 UTC');
  assert.equal(w.to.toISOString(), '2031-03-09T23:00:00.000Z');
  assert.equal(startOfDay('2031-03-06', LAGOS).toISOString(), '2031-03-05T23:00:00.000Z');
  assert.ok((w.to.getTime() - w.from.getTime()) / 86_400_000 <= 42);
  // A week that contains a clock change is 7 calendar days but not 7 x 24 hours.
  const dst = weekWindow('2031-03-09', NEW_YORK);
  assert.equal((dst.to.getTime() - dst.from.getTime()) / 3_600_000, 167, 'the week the clocks go forward is an hour short');
});

test('weekOf: Monday to Sunday whatever day of the week is asked about, including a Sunday', () => {
  const monday = ['2031-03-03', '2031-03-04', '2031-03-05', '2031-03-06', '2031-03-07', '2031-03-08', '2031-03-09'];
  for (const day of monday) assert.deepEqual(weekOf(day), monday, day);
  assert.deepEqual(weekOf('2031-03-10')[0], '2031-03-10');
});

test('formatting: 09:00 – 17:00, Thursday, 15 October, and the week strip letters', () => {
  const start = new Date('2031-10-15T08:00:00Z');
  const end = new Date('2031-10-15T16:00:00Z');
  assert.equal(formatRange(start, end, LAGOS), '09:00 – 17:00');
  assert.equal(formatLongDate('2031-10-15'), 'Wednesday, 15 October');
  assert.equal(formatLongDate('2026-10-15'), 'Thursday, 15 October');
  assert.deepEqual(stripLabel('2026-10-12'), { letter: 'M', day: 12 });
  assert.deepEqual(stripLabel('2026-10-18'), { letter: 'S', day: 18 });
});

test('greeting follows the hour on the team\'s clock', () => {
  assert.equal(greetingFor(new Date('2031-03-04T07:00:00Z'), LAGOS), 'Good morning'); // 08:00
  assert.equal(greetingFor(new Date('2031-03-04T11:30:00Z'), LAGOS), 'Good afternoon'); // 12:30
  assert.equal(greetingFor(new Date('2031-03-04T18:00:00Z'), LAGOS), 'Good evening'); // 19:00
  assert.equal(greetingFor(new Date('2031-03-04T18:00:00Z'), NEW_YORK), 'Good afternoon'); // 13:00
});

test('shiftsOnDay: a shift shows on every day it touches, soonest first; one that only touches midnight does not', () => {
  const mk = (id: string, s: string, e: string) => ({ id, startsAt: s, endsAt: e });
  const shifts = [
    mk('b', '2031-03-04T12:00:00Z', '2031-03-04T14:00:00Z'),
    mk('a', '2031-03-04T08:00:00Z', '2031-03-04T10:00:00Z'),
    mk('overnight', '2031-03-04T21:00:00Z', '2031-03-05T01:00:00Z'), // 22:00 to 02:00 in Lagos
    mk('before', '2031-03-03T08:00:00Z', '2031-03-03T22:00:00Z'), // ends at 23:00 Lagos on the 3rd
    mk('touches', '2031-03-03T20:00:00Z', '2031-03-03T23:00:00Z'), // ends exactly at midnight Lagos (the 4th starts)
  ];
  assert.deepEqual(shiftsOnDay(shifts, '2031-03-04', LAGOS).map((s) => s.id), ['a', 'b', 'overnight']);
  assert.deepEqual(shiftsOnDay(shifts, '2031-03-05', LAGOS).map((s) => s.id), ['overnight']);
  assert.deepEqual(shiftsOnDay(shifts, '2031-03-03', LAGOS).map((s) => s.id), ['before', 'touches']);
});

test('parseTime: 24-hour times only', () => {
  assert.deepEqual(parseTime('09:00'), { hour: 9, minute: 0 });
  assert.deepEqual(parseTime(' 9:05 '), { hour: 9, minute: 5 });
  assert.deepEqual(parseTime('23:59'), { hour: 23, minute: 59 });
  for (const bad of ['24:00', '9', '09:60', '9am', '', '09-00', '9:5']) assert.equal(parseTime(bad), null, bad);
});
