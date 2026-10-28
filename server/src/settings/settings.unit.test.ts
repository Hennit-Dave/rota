import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateBody } from './schemas.js';
import { DEFAULT_SETTINGS, settingsFromRow } from './service.js';

// The request schema (security.md: strict, whole request) and the row mapping. No database.

const ok = (body: unknown) => assert.equal(updateBody.safeParse(body).success, true, JSON.stringify(body));
const bad = (body: unknown) => assert.equal(updateBody.safeParse(body).success, false, JSON.stringify(body));

test('each setting is accepted on its own', () => {
  ok({ theme: 'dark' });
  ok({ theme: 'system' });
  ok({ language: 'en' });
  ok({ timeZone: 'Africa/Lagos' });
  ok({ notifyShiftChanges: false });
  ok({ notifySwapUpdates: true });
  ok({ notifyBilling: false });
  ok({ quietHours: { enabled: true, start: '22:00', end: '06:00' } });
  ok({ quietHours: { enabled: false, start: '00:00', end: '23:59' } });
});

test('one field per request: two settings, none, or an unknown key are refused', () => {
  bad({});
  bad({ theme: 'dark', language: 'en' });
  bad({ theme: 'dark', notifyBilling: true });
  bad({ nonsense: 1 });
  bad({ theme: 'dark', updatedAt: '2031-01-01T00:00:00Z' });
  bad({ userId: '6f1b2f4e-0f0a-4a3c-9a65-6f0f0f0f0f0f', theme: 'dark' });
});

test('values outside the allowed set are refused', () => {
  bad({ theme: 'purple' });
  bad({ theme: '' });
  bad({ language: 'fr' }); // 'en' only until there are translations (ADR 0024)
  bad({ timeZone: 'Mars/Base' });
  bad({ timeZone: '' });
  bad({ timeZone: null }); // a time zone is chosen, never cleared: NULL only means "not chosen yet"
  bad({ notifyBilling: 'yes' });
  bad({ notifyShiftChanges: 1 });
});

test('quiet hours: HH:MM 24-hour, start and end different, nothing extra', () => {
  bad({ quietHours: { enabled: true, start: '25:00', end: '06:00' } });
  bad({ quietHours: { enabled: true, start: '22:60', end: '06:00' } });
  bad({ quietHours: { enabled: true, start: '9:00', end: '06:00' } });
  bad({ quietHours: { enabled: true, start: '22:00:00', end: '06:00' } });
  bad({ quietHours: { enabled: true, start: '22:00', end: '22:00' } });
  bad({ quietHours: { enabled: true, start: '22:00' } });
  bad({ quietHours: { start: '22:00', end: '06:00' } });
  bad({ quietHours: { enabled: true, start: '22:00', end: '06:00', zone: 'UTC' } });
  bad({ quietHours: { enabled: 'on', start: '22:00', end: '06:00' } });
});

test('a database row maps to per-field value and updatedAt', () => {
  const stamp = new Date('2031-03-04T10:00:00.123Z');
  const view = settingsFromRow({
    quiet_hours_enabled: true,
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    quiet_hours_updated_at: stamp,
    time_zone: 'Africa/Lagos',
    time_zone_updated_at: null,
    notify_shift_changes: false,
    notify_shift_changes_updated_at: stamp,
    notify_swap_updates: true,
    notify_swap_updates_updated_at: null,
    notify_billing: true,
    notify_billing_updated_at: null,
    language: 'en',
    language_updated_at: null,
    theme: 'dark',
    theme_updated_at: stamp,
  });
  assert.deepEqual(view.quietHours, { value: { enabled: true, start: '22:00', end: '07:00' }, updatedAt: stamp });
  assert.deepEqual(view.timeZone, { value: 'Africa/Lagos', updatedAt: null });
  assert.deepEqual(view.notifyShiftChanges, { value: false, updatedAt: stamp });
  assert.deepEqual(view.theme, { value: 'dark', updatedAt: stamp });
});

test('the defaults say nothing was ever changed', () => {
  for (const [name, field] of Object.entries(DEFAULT_SETTINGS)) assert.equal(field.updatedAt, null, name);
  assert.deepEqual(DEFAULT_SETTINGS.quietHours.value, { enabled: false, start: '22:00', end: '06:00' });
  assert.equal(DEFAULT_SETTINGS.timeZone.value, null);
  assert.equal(DEFAULT_SETTINGS.theme.value, 'system');
  assert.equal(DEFAULT_SETTINGS.language.value, 'en');
});
