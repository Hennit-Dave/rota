import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleChoice, validateInviteEmail } from './inviteFormState';

test('only presence is checked on tap; the shape of the address is the server\'s decision', () => {
  assert.equal(validateInviteEmail(''), 'Enter a valid email address.');
  assert.equal(validateInviteEmail('   '), 'Enter a valid email address.');
  assert.equal(validateInviteEmail('sofia@example'), undefined, 'the server decides this one (Figma 291:741)');
});

test('an Owner may choose Manager or Staff, and starts on Staff (Figma 291:963)', () => {
  assert.deepEqual(roleChoice(['manager', 'staff'], null), { selected: 'staff', options: ['manager', 'staff'], canChoose: true });
  assert.equal(roleChoice(['manager', 'staff'], 'manager')?.selected, 'manager');
});

test('a Manager is offered Staff only, shown but not changeable (Figma 103:2462, 291:988)', () => {
  assert.deepEqual(roleChoice(['staff'], null), { selected: 'staff', options: ['staff'], canChoose: false });
  assert.equal(roleChoice(['staff'], 'manager')?.selected, 'staff', 'a stale choice the server no longer offers is never sent');
});

test('Owner is never offered, and nothing is offered when the server offers nothing', () => {
  assert.equal(roleChoice([], null), null);
  assert.equal(roleChoice([], 'staff'), null);
  const options = roleChoice(['manager', 'staff'], null)?.options ?? [];
  assert.ok(!options.includes('owner' as never));
});
