import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, isInQuietWindow } from './quietHours.js';

const window = (start: string, end: string, enabled = true) => ({ enabled, start, end });
const at = (iso: string) => new Date(iso);

test('quiet hours off: send now, whatever the time', () => {
  const d = decide({ quietHours: window('22:00', '06:00', false), timeZone: 'UTC', fallbackTimeZone: 'UTC', now: at('2026-11-03T23:30:00Z'), urgent: false });
  assert.deepEqual(d, { send: true });
});

test('an urgent push is never delayed, even inside the window', () => {
  const d = decide({ quietHours: window('22:00', '06:00'), timeZone: 'UTC', fallbackTimeZone: 'UTC', now: at('2026-11-03T23:30:00Z'), urgent: true });
  assert.deepEqual(d, { send: true });
});

test('a window that crosses midnight: late evening and early morning are quiet, daytime is not', () => {
  const q = window('22:00', '06:00');
  const at2330 = decide({ quietHours: q, timeZone: 'UTC', fallbackTimeZone: 'UTC', now: at('2026-11-03T23:30:00Z'), urgent: false });
  assert.deepEqual(at2330, { send: false, delayUntil: at('2026-11-04T06:00:00Z') }, 'evening: delayed to 06:00 the NEXT day');
  const at0200 = decide({ quietHours: q, timeZone: 'UTC', fallbackTimeZone: 'UTC', now: at('2026-11-03T02:00:00Z'), urgent: false });
  assert.deepEqual(at0200, { send: false, delayUntil: at('2026-11-03T06:00:00Z') }, 'early morning: delayed to 06:00 the SAME day');
  assert.deepEqual(decide({ quietHours: q, timeZone: 'UTC', fallbackTimeZone: 'UTC', now: at('2026-11-03T12:00:00Z'), urgent: false }), { send: true });
});

test('the window is start-inclusive and end-exclusive', () => {
  const q = window('22:00', '06:00');
  assert.equal(isInQuietWindow(q, 22 * 60), true);
  assert.equal(isInQuietWindow(q, 6 * 60), false);
  assert.equal(isInQuietWindow(q, 6 * 60 - 1), true);
  assert.equal(isInQuietWindow(q, 22 * 60 - 1), false);
});

test('a same-day window (13:00 to 14:30)', () => {
  const q = window('13:00', '14:30');
  assert.equal(isInQuietWindow(q, 12 * 60 + 59), false);
  assert.equal(isInQuietWindow(q, 13 * 60), true);
  assert.equal(isInQuietWindow(q, 14 * 60 + 29), true);
  assert.equal(isInQuietWindow(q, 14 * 60 + 30), false);
});

test('the delay ends to the second, not at the next whole minute', () => {
  const d = decide({ quietHours: window('22:00', '06:00'), timeZone: 'UTC', fallbackTimeZone: 'UTC', now: at('2026-11-03T23:30:41.250Z'), urgent: false });
  assert.deepEqual(d, { send: false, delayUntil: at('2026-11-04T06:00:00.000Z') });
});

test("the user's own time zone decides, not the server's or the team's", () => {
  // 23:30 UTC is 00:30 in Lagos (UTC+1, no DST) and 18:30 in New York (UTC-5 in November).
  const q = window('22:00', '06:00');
  const lagos = decide({ quietHours: q, timeZone: 'Africa/Lagos', fallbackTimeZone: 'America/New_York', now: at('2026-11-03T23:30:00Z'), urgent: false });
  assert.deepEqual(lagos, { send: false, delayUntil: at('2026-11-04T05:00:00Z') }, 'quiet in Lagos: 06:00 Lagos is 05:00 UTC');
  const ny = decide({ quietHours: q, timeZone: 'America/New_York', fallbackTimeZone: 'Africa/Lagos', now: at('2026-11-03T23:30:00Z'), urgent: false });
  assert.deepEqual(ny, { send: true }, 'not quiet in New York at 18:30');
});

test('no time zone chosen: the team time zone is used', () => {
  const q = window('22:00', '06:00');
  const viaTeam = decide({ quietHours: q, timeZone: null, fallbackTimeZone: 'Africa/Lagos', now: at('2026-11-03T23:30:00Z'), urgent: false });
  assert.deepEqual(viaTeam, { send: false, delayUntil: at('2026-11-04T05:00:00Z') });
  const viaOwn = decide({ quietHours: q, timeZone: 'America/New_York', fallbackTimeZone: 'Africa/Lagos', now: at('2026-11-03T23:30:00Z'), urgent: false });
  assert.deepEqual(viaOwn, { send: true }, 'an own time zone beats the team fallback');
});

test('a half-hour offset zone (Asia/Kolkata, UTC+5:30) is read correctly', () => {
  // 17:00 UTC = 22:30 Kolkata: quiet until 06:00 Kolkata = 00:30 UTC.
  const d = decide({ quietHours: window('22:00', '06:00'), timeZone: 'Asia/Kolkata', fallbackTimeZone: 'UTC', now: at('2026-11-03T17:00:00Z'), urgent: false });
  assert.deepEqual(d, { send: false, delayUntil: at('2026-11-04T00:30:00Z') });
});

test('daylight saving: 23:30 on the night the clocks go back (America/New_York, 2026-11-01) is still inside the window and ends at 06:00 local', () => {
  // On 2026-11-01 New York returns to standard time at 02:00 local, so 06:00 local is 11:00 UTC. 23:30 on 2026-10-31 local is 03:30 UTC on 2026-11-01 (EDT, UTC-4).
  const d = decide({ quietHours: window('22:00', '06:00'), timeZone: 'America/New_York', fallbackTimeZone: 'UTC', now: at('2026-11-01T03:30:00Z'), urgent: false });
  assert.equal(d.send, false);
  if (!d.send) {
    // The decision is computed in wall-clock minutes (6h30m left on the local clock), so it lands at 10:00 UTC, an hour before the real 06:00 EST (11:00 UTC).
    // That is the documented limit: the job decides again when it wakes (and finds 05:00 EST still quiet), so it is never sent inside the window.
    assert.equal(d.delayUntil.toISOString(), '2026-11-01T10:00:00.000Z');
  }
  const recheck = decide({ quietHours: window('22:00', '06:00'), timeZone: 'America/New_York', fallbackTimeZone: 'UTC', now: at('2026-11-01T10:00:00Z'), urgent: false });
  assert.equal(recheck.send, false, 'at 10:00 UTC it is 05:00 EST: still quiet, so it defers again');
});

test('a malformed window time is refused loudly, not guessed', () => {
  assert.throws(() => isInQuietWindow({ enabled: true, start: '25:00', end: '06:00' }, 0), /HH:MM/);
});
