import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTimeZone, filterTimeZones } from './timeZoneSearch';
import { timeZones } from './timeZones';

test('every offered time zone is one the server accepts: the list is a subset of Node 24\'s own list (the server\'s runtime)', () => {
  const serverList = new Set(Intl.supportedValuesOf('timeZone'));
  const unknown = timeZones.filter((zone) => !serverList.has(zone));
  assert.deepEqual(unknown, [], 'regenerate app/src/teams/timeZones.ts');
  assert.ok(timeZones.includes('Africa/Lagos'), 'the Figma example is offered');
  assert.equal(new Set(timeZones).size, timeZones.length, 'no duplicates');
  assert.ok(timeZones.length > 300);
});

test('search ignores case, spaces, underscores and slashes', () => {
  assert.ok(filterTimeZones(timeZones, 'new york').includes('America/New_York'));
  assert.ok(filterTimeZones(timeZones, 'LAGOS').includes('Africa/Lagos'));
  assert.ok(filterTimeZones(timeZones, 'africa lagos').includes('Africa/Lagos'));
  assert.deepEqual(filterTimeZones(['Africa/Lagos', 'Europe/London'], 'lon'), ['Europe/London'], 'order kept');
  assert.deepEqual(filterTimeZones(timeZones, 'zzzz-no-such-place'), []);
  assert.equal(filterTimeZones(timeZones, '   '), timeZones, 'a blank search shows everything');
});

test('the phone\'s time zone is the starting choice only when it is offered', () => {
  assert.equal(defaultTimeZone(timeZones, () => 'Africa/Lagos'), 'Africa/Lagos');
  assert.equal(defaultTimeZone(timeZones, () => 'Asia/Atlantis'), null, 'an unknown name is not preselected');
  assert.equal(defaultTimeZone(timeZones, () => undefined), null);
  assert.equal(defaultTimeZone(timeZones, () => { throw new Error('no Intl'); }), null);
});
