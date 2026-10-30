import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../http/errors.js';
import { boundaryOutcome, checkSelection, type ActiveMember } from './reductions.js';

const member = (id: string, role: ActiveMember['role'] = 'staff'): ActiveMember => ({ userId: id, role });
const team = [member('o', 'owner'), member('m', 'manager'), member('a'), member('b'), member('c')];
const code = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : 'other';
  }
  return 'none';
};

test('exactly (active - target) distinct active non-Owner members must be chosen', () => {
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 3, selected: ['a', 'b'] })), 'none');
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 3, selected: ['a'] })), 'selection_required');
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 3, selected: [] })), 'selection_required');
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 3, selected: ['a', 'b', 'c'] })), 'selection_invalid');
});

test('a team that already fits needs nobody chosen, and choosing someone is refused', () => {
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 5, selected: [] })), 'none');
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 9, selected: [] })), 'none');
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 5, selected: ['a'] })), 'selection_invalid');
});

test('the Owner, a stranger and a repeated person are never valid choices', () => {
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 4, selected: ['o'] })), 'selection_invalid');
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 4, selected: ['nobody'] })), 'selection_invalid');
  assert.equal(code(() => checkSelection({ members: team, targetSeats: 3, selected: ['a', 'a'] })), 'selection_invalid');
});

test('the boundary outcome: fits is ready; too many with the accepted fallback continues; too many without it is blocked', () => {
  assert.equal(boundaryOutcome({ activeAfter: 3, targetSeats: 3, fallbackAccepted: false }), 'ready');
  assert.equal(boundaryOutcome({ activeAfter: 2, targetSeats: 3, fallbackAccepted: true }), 'ready');
  assert.equal(boundaryOutcome({ activeAfter: 4, targetSeats: 3, fallbackAccepted: true }), 'continuing');
  assert.equal(boundaryOutcome({ activeAfter: 4, targetSeats: 3, fallbackAccepted: false }), 'blocked');
});
