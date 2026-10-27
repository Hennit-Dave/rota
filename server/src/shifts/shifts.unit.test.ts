import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadShiftsConfig } from './config.js';
import { createShiftSchemas, timesProblem } from './schemas.js';

const config = loadShiftsConfig({});
const schemas = createShiftSchemas(config);
const at = (h: number, m = 0) => new Date(Date.UTC(2031, 2, 4, h, m));

test('approved defaults: a 42-day calendar range, and text sizes that only bound the request', () => {
  assert.deepEqual(config, { maxRangeDays: 42, titleMax: 100, areaMax: 100, noteMax: 500 });
});

test('the range can be overridden by env, and a bad value stops the server instead of weakening it', () => {
  assert.equal(loadShiftsConfig({ SHIFTS_MAX_RANGE_DAYS: '14' }).maxRangeDays, 14);
  for (const bad of ['0', '-1', 'six', '1.5']) assert.throws(() => loadShiftsConfig({ SHIFTS_MAX_RANGE_DAYS: bad }), /SHIFTS_MAX_RANGE_DAYS/);
});

test('timesProblem: the end is after the start, and the break fits inside the shift (its ceiling is the shift length, no invented number)', () => {
  assert.equal(timesProblem({ startsAt: at(9), endsAt: at(17), breakMinutes: 30 }), null);
  assert.deepEqual(timesProblem({ startsAt: at(9), endsAt: at(9) }), { path: 'endsAt', code: 'must_be_after_start' });
  assert.deepEqual(timesProblem({ startsAt: at(9), endsAt: at(8) }), { path: 'endsAt', code: 'must_be_after_start' });
  assert.equal(timesProblem({ startsAt: at(9), endsAt: at(10), breakMinutes: 60 }), null, 'exactly as long as the shift is allowed');
  assert.deepEqual(timesProblem({ startsAt: at(9), endsAt: at(10), breakMinutes: 61 }), { path: 'breakMinutes', code: 'break_too_long', max: 60 });
  assert.equal(timesProblem({ startsAt: at(9), endsAt: at(10), breakMinutes: null }), null);
});

test('instants must carry an offset or Z, and become Dates at millisecond precision', () => {
  const ok = schemas.create.safeParse({ title: ' Morning ', startsAt: '2031-03-04T09:00:00.123+01:00', endsAt: '2031-03-04T17:00:00Z' });
  assert.equal(ok.success, true);
  assert.equal(ok.data?.title, 'Morning', 'trimmed');
  assert.equal((ok.data?.startsAt as Date).toISOString(), '2031-03-04T08:00:00.123Z', 'the offset is applied');
  assert.equal(schemas.create.safeParse({ title: 'x', startsAt: '2031-03-04T09:00:00', endsAt: '2031-03-04T17:00:00Z' }).success, false, 'no offset: refused');
});

test('create and update are strict; an update must change something; null clears optional fields', () => {
  assert.equal(schemas.create.safeParse({ title: 'x', startsAt: at(9).toISOString(), endsAt: at(10).toISOString(), extra: 1 }).success, false);
  assert.equal(schemas.update.safeParse({}).success, false);
  assert.equal(schemas.update.safeParse({ extra: 1 }).success, false);
  const cleared = schemas.update.safeParse({ area: null, note: null, breakMinutes: null, assignedUserId: null });
  assert.equal(cleared.success, true);
  assert.equal(schemas.update.safeParse({ title: 'x' }).success, true);
  assert.equal(schemas.update.safeParse({ title: '' }).success, false, 'a title cannot be cleared');
});

test('ids are canonical UUIDs only', () => {
  const id = '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b';
  assert.equal(schemas.shiftParams.safeParse({ teamId: id, shiftId: id }).success, true);
  assert.equal(schemas.shiftParams.safeParse({ teamId: id.toUpperCase(), shiftId: id }).success, false);
  assert.equal(schemas.shiftParams.safeParse({ teamId: id, shiftId: 'nope' }).success, false);
  assert.equal(schemas.shiftParams.safeParse({ teamId: id, shiftId: id, extra: 1 }).success, false);
});

test('the calendar query: from before to, at most the cap, mine defaults to false', () => {
  const q = (extra: Record<string, unknown>) => schemas.list.safeParse({ from: '2031-03-04T00:00:00Z', to: '2031-03-11T00:00:00Z', ...extra });
  assert.equal(q({}).data?.mine, false);
  assert.equal(q({ mine: 'true' }).data?.mine, true);
  assert.equal(q({ mine: 'yes' }).success, false);
  assert.equal(q({ to: '2031-03-04T00:00:00Z' }).success, false, 'to equal to from');
  assert.equal(q({ to: '2031-04-15T00:00:00.000Z' }).success, true, '42 days');
  assert.equal(q({ to: '2031-04-15T00:00:00.001Z' }).success, false, '42 days and a millisecond');
});
