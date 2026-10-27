import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shiftFormCopy } from './shiftCopy';
import { changesFrom, validateShiftForm, valuesFromShift, type ShiftFormValues } from './shiftForm';
import type { Shift } from './shiftResponses';

const LAGOS = 'Africa/Lagos';
const base: ShiftFormValues = { title: 'Morning service', date: '2031-03-04', start: '09:00', end: '17:00', assigneeId: null };

test('a valid form becomes two UTC instants read on the team clock (09:00-17:00 in Lagos is 08:00-16:00 UTC)', () => {
  const result = validateShiftForm(base, LAGOS);
  assert.deepEqual(result.errors, {});
  assert.equal(result.startsAt?.toISOString(), '2031-03-04T08:00:00.000Z');
  assert.equal(result.endsAt?.toISOString(), '2031-03-04T16:00:00.000Z');
});

test('an end earlier than the start runs past midnight into the next day; an end equal to the start is an error', () => {
  const overnight = validateShiftForm({ ...base, start: '22:00', end: '02:00' }, LAGOS);
  assert.equal(overnight.startsAt?.toISOString(), '2031-03-04T21:00:00.000Z');
  assert.equal(overnight.endsAt?.toISOString(), '2031-03-05T01:00:00.000Z');
  assert.deepEqual(validateShiftForm({ ...base, start: '09:00', end: '09:00' }, LAGOS).errors, { end: shiftFormCopy.errors.endAfterStart });
});

test('presence and shape only: blank title, impossible date, malformed times each get their own message', () => {
  assert.deepEqual(validateShiftForm({ ...base, title: '   ' }, LAGOS).errors, { title: shiftFormCopy.errors.titleRequired });
  assert.deepEqual(validateShiftForm({ ...base, date: '2031-02-30' }, LAGOS).errors, { date: shiftFormCopy.errors.dateInvalid });
  assert.deepEqual(validateShiftForm({ ...base, date: '04/03/2031' }, LAGOS).errors, { date: shiftFormCopy.errors.dateInvalid });
  assert.deepEqual(validateShiftForm({ ...base, start: '9am', end: '' }, LAGOS).errors, {
    start: shiftFormCopy.errors.timeInvalid,
    end: shiftFormCopy.errors.timeInvalid,
  });
  const everything = validateShiftForm({ title: '', date: 'x', start: '', end: '', assigneeId: null }, LAGOS);
  assert.deepEqual(Object.keys(everything.errors).sort(), ['date', 'end', 'start', 'title']);
  assert.equal(everything.startsAt, undefined);
});

test('the same typed 09:00 means a different instant in a different team zone', () => {
  assert.equal(validateShiftForm(base, 'America/New_York').startsAt?.toISOString(), '2031-03-04T14:00:00.000Z');
});

const shift: Shift = {
  id: 's1',
  title: 'Morning service',
  area: null,
  startsAt: '2031-03-04T08:00:00.000Z',
  endsAt: '2031-03-04T16:00:00.000Z',
  breakMinutes: null,
  note: null,
  assignee: { id: 'u1', name: 'Amara Okafor' },
  status: 'scheduled',
};

test('valuesFromShift shows the shift on the team clock', () => {
  assert.deepEqual(valuesFromShift(shift, LAGOS), { title: 'Morning service', date: '2031-03-04', start: '09:00', end: '17:00', assigneeId: 'u1' });
  assert.equal(valuesFromShift({ ...shift, assignee: null }, LAGOS).assigneeId, null);
});

test('changesFrom sends only what differs; an untouched form sends nothing; unassigning sends null', () => {
  const same = { title: ' Morning service ', startsAt: new Date(shift.startsAt), endsAt: new Date(shift.endsAt), assigneeId: 'u1' };
  assert.deepEqual(changesFrom(shift, same), {});
  assert.deepEqual(changesFrom(shift, { ...same, title: 'Evening' }), { title: 'Evening' });
  assert.deepEqual(changesFrom(shift, { ...same, assigneeId: null }), { assignedUserId: null });
  assert.deepEqual(changesFrom(shift, { ...same, endsAt: new Date('2031-03-04T17:00:00.000Z') }), { endsAt: '2031-03-04T17:00:00.000Z' });
  assert.deepEqual(changesFrom({ ...shift, assignee: null }, { ...same, assigneeId: 'u2' }), { assignedUserId: 'u2' });
});
