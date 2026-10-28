import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MutationObserver, QueryClient, onlineManager } from '@tanstack/query-core';
import { ApiError, OfflineError } from '../api/errors';
import { useSessionStore } from '../state/sessionStore';
import { darkColors, lightColors } from '../theme/colors';
import { resolveColors } from '../theme/resolveColors';
import { json, makeHarness } from '../testkit';
import { navScheduleXml, statusErrorXml } from '../ui/icons/figmaIcons';
import { themeStrokes } from '../ui/recolour';
import { createSettingsApi } from './settingsApi';
import { checkQuietHours, describeChange, formatQuietHours, ownsATeam, settingsHeader } from './settingsDisplay';
import { createSettingMutationOptions, maySaveSetting } from './settingsMutation';
import type { SettingsNotice } from './settingsNotice';
import { parseSettings, settingMutationKey, settingsKey, type Settings } from './settingsResponses';

// Settings (ADR 0024; brief Requirement 7; app-state.md tests 3, 4, 5, 6, 12, 13 and 14). Real TanStack core, no screen.

const stamp = '2031-03-04T10:00:00.000Z';
const body = (over: Record<string, unknown> = {}) => ({
  settings: {
    quietHours: { value: { enabled: true, start: '22:00', end: '07:00' }, updatedAt: stamp },
    timeZone: { value: 'Africa/Lagos', updatedAt: stamp },
    notifyShiftChanges: { value: true, updatedAt: null },
    notifySwapUpdates: { value: true, updatedAt: null },
    notifyBilling: { value: true, updatedAt: null },
    language: { value: 'en', updatedAt: null },
    theme: { value: 'light', updatedAt: stamp },
    ...over,
  },
});
const settings = (over: Record<string, unknown> = {}) => parseSettings(body(over)) as Settings;

// ---- reading the server's answer ----

test('the server answer is read into per-field value and updatedAt', () => {
  const s = settings();
  assert.deepEqual(s.quietHours, { value: { enabled: true, start: '22:00', end: '07:00' }, updatedAt: stamp });
  assert.deepEqual(s.notifyBilling, { value: true, updatedAt: null });
  assert.equal(s.theme.value, 'light');
});

test('anything that is not the expected shape is refused, never half-read', () => {
  assert.equal(parseSettings(null), null);
  assert.equal(parseSettings({}), null);
  assert.equal(parseSettings({ settings: null }), null);
  assert.equal(parseSettings(body({ theme: { value: 'purple', updatedAt: null } })), null);
  assert.equal(parseSettings(body({ theme: { value: 'dark', updatedAt: 'yesterday' } })), null);
  assert.equal(parseSettings(body({ notifyBilling: { value: 'yes', updatedAt: null } })), null);
  assert.equal(parseSettings(body({ quietHours: { value: { enabled: true, start: '22:00' }, updatedAt: null } })), null);
  assert.equal(parseSettings(body({ language: undefined })), null);
});

// ---- the requests ----

test('GET /settings and PATCH /settings: ONE field per change, and never an updatedAt or a user ID', async () => {
  const h = makeHarness({ handler: () => json(200, body()) });
  const api = createSettingsApi(h.client);
  await api.get();
  await api.change({ key: 'theme', value: 'dark' });
  await api.change({ key: 'quietHours', value: { enabled: true, start: '21:00', end: '06:00' } });
  await api.change({ key: 'notifyBilling', value: false });
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.path}`), ['GET /settings', 'PATCH /settings', 'PATCH /settings', 'PATCH /settings']);
  assert.deepEqual(h.calls[1]?.body, { theme: 'dark' });
  assert.deepEqual(h.calls[2]?.body, { quietHours: { enabled: true, start: '21:00', end: '06:00' } });
  assert.deepEqual(h.calls[3]?.body, { notifyBilling: false });
  assert.equal(h.calls[1]?.authorization, 'Bearer old');
  for (const call of h.calls.slice(1)) assert.equal(JSON.stringify(call.body).includes('updatedAt'), false);
});

test('an answer the app cannot read is an error, not an empty screen', async () => {
  const h = makeHarness({ handler: () => json(200, { settings: { theme: 'dark' } }) });
  await assert.rejects(createSettingsApi(h.client).get(), (e) => e instanceof ApiError && e.code === 'invalid_response');
});

// ---- the optimistic update with rollback ----

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A promise the test settles by hand, either way (the shared `deferred` only resolves). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const KEY = settingsKey('u1');

function setup(initial = settings()) {
  const client = new QueryClient();
  client.setQueryData<Settings>(KEY, initial);
  const notices: Array<SettingsNotice | null> = [];
  const notify = (n: SettingsNotice | null) => void notices.push(n);
  return { client, notices, notify };
}
const cached = (client: QueryClient) => client.getQueryData<Settings>(KEY) as Settings;

test('TEST 3 (settings rollback): the new value shows at once with the server\'s own updatedAt; a failure restores the previous value and says so', async () => {
  const { client, notices, notify } = setup();
  const wait = deferred<Settings>();
  const options = createSettingMutationOptions(client, 'u1', 'theme', () => ({ change: () => wait.promise }), notify);
  const observer = new MutationObserver(client, options);
  const done = observer.mutate('dark').catch(() => {});
  await tick();
  assert.deepEqual(cached(client).theme, { value: 'dark', updatedAt: stamp }, 'shown before any answer, and the app invented no timestamp');
  assert.equal(client.isMutating({ mutationKey: settingMutationKey('u1', 'theme') }), 1, 'this field is pending: its control stays off');
  wait.reject(new ApiError(500, 'internal_error', 'x', 'req-1'));
  await done;
  assert.deepEqual(cached(client).theme, { value: 'light', updatedAt: stamp }, 'the previous value is back');
  assert.equal(client.isMutating({ mutationKey: settingMutationKey('u1', 'theme') }), 0, 'and the control is free again');
  const last = notices.at(-1);
  assert.equal(last?.kind, 'failed');
  if (last?.kind === 'failed') {
    assert.equal(last.reason, 'error');
    assert.deepEqual(last.change, { key: 'theme', value: 'dark' });
    assert.deepEqual(last.previous, { key: 'theme', value: 'light' });
    assert.equal(last.requestId, 'req-1');
  }
});

test('on success only THIS field is taken from the answer, and the notice says saved', async () => {
  const { client, notices, notify } = setup();
  const answer = settings({ theme: { value: 'dark', updatedAt: '2031-03-04T11:00:00.000Z' }, notifyBilling: { value: false, updatedAt: '2031-03-04T11:00:00.000Z' } });
  const options = createSettingMutationOptions(client, 'u1', 'theme', () => ({ change: async () => answer }), notify);
  await new MutationObserver(client, options).mutate('dark');
  assert.deepEqual(cached(client).theme, { value: 'dark', updatedAt: '2031-03-04T11:00:00.000Z' }, 'the server\'s stamp replaces the guess');
  assert.equal(cached(client).notifyBilling.value, true, 'another field of the answer is not copied in (its own change may still be on its way)');
  assert.deepEqual(notices.at(-1), { kind: 'saved', change: { key: 'theme', value: 'dark' } });
  assert.equal(client.getQueryState(KEY)?.isInvalidated, true, 'and the server is asked again, so the guess never stays');
});

test('TEST 13 (overlapping changes): the theme is pending, quiet hours succeeds, then the theme fails: the theme rolls back and quiet hours keeps its new value', async () => {
  const { client, notify } = setup();
  const themeWait = deferred<Settings>();
  const theme = new MutationObserver(client, createSettingMutationOptions(client, 'u1', 'theme', () => ({ change: () => themeWait.promise }), notify));
  const themeDone = theme.mutate('dark').catch(() => {});
  await tick();

  const newHours = { enabled: true, start: '21:00', end: '05:00' };
  const quiet = new MutationObserver(
    client,
    createSettingMutationOptions(client, 'u1', 'quietHours', () => ({ change: async () => settings({ quietHours: { value: newHours, updatedAt: '2031-03-04T12:00:00.000Z' } }) }), notify),
  );
  await quiet.mutate(newHours);
  assert.deepEqual(cached(client).quietHours.value, newHours);
  assert.equal(cached(client).theme.value, 'dark', 'the theme guess is still on screen while it is pending');
  assert.equal(client.getQueryState(KEY)?.isInvalidated, false, 'no refetch while another setting is still on its way: it would flash the old theme back');

  themeWait.reject(new ApiError(503, 'service_unavailable', 'x', null));
  await themeDone;
  assert.equal(cached(client).theme.value, 'light', 'the theme is rolled back');
  assert.deepEqual(cached(client).quietHours.value, newHours, 'quiet hours keeps the change that succeeded');
});

test('a failure does not undo a value the server has already brought (a refetch replaced the guess)', async () => {
  const { client, notify } = setup();
  const wait = deferred<Settings>();
  const observer = new MutationObserver(client, createSettingMutationOptions(client, 'u1', 'theme', () => ({ change: () => wait.promise }), notify));
  const done = observer.mutate('dark').catch(() => {});
  await tick();
  // The foreground refetch lands another device's choice while this change is out.
  client.setQueryData<Settings>(KEY, { ...cached(client), theme: { value: 'system', updatedAt: '2031-03-04T13:00:00.000Z' } });
  wait.reject(new ApiError(500, 'internal_error', 'x', null));
  await done;
  assert.equal(cached(client).theme.value, 'system', 'the server\'s value stands');
});

test('TEST 5 (per field): a theme change on one device and a quiet-hours change on another are both kept', async () => {
  // Device A changes the theme; the server's answer already carries device B's quiet hours (B saved first). A takes only its own field and keeps its copy of the rest,
  // and the refetch that follows brings B's value in. Neither change is lost.
  const { client, notify } = setup();
  const b = { enabled: true, start: '20:00', end: '04:00' };
  const answer = settings({ theme: { value: 'dark', updatedAt: '2031-03-04T14:00:00.000Z' }, quietHours: { value: b, updatedAt: '2031-03-04T13:59:00.000Z' } });
  await new MutationObserver(client, createSettingMutationOptions(client, 'u1', 'theme', () => ({ change: async () => answer }), notify)).mutate('dark');
  assert.equal(cached(client).theme.value, 'dark');
  // The follow-up refetch (invalidated above) replaces the rest with the server's truth.
  client.setQueryData<Settings>(KEY, answer);
  assert.deepEqual(cached(client).quietHours.value, b);
  assert.equal(cached(client).theme.value, 'dark');
});

// ---- never queued offline (app-state.md tests 12 and 14) ----

test('the gate: offline nothing is sent, a pending field refuses a second change, online goes ahead', () => {
  assert.equal(maySaveSetting({ online: false, pending: false }), 'offline');
  assert.equal(maySaveSetting({ online: true, pending: true }), 'busy');
  assert.equal(maySaveSetting({ online: false, pending: true }), 'busy');
  assert.equal(maySaveSetting({ online: true, pending: false }), 'yes');
});

test('TEST 12 (no delayed offline write): a change that fails offline is rolled back, and reconnecting sends nothing more', async () => {
  const { client, notices, notify } = setup();
  let calls = 0;
  const api = () => ({
    change: async () => {
      calls += 1;
      throw new OfflineError();
    },
  });
  onlineManager.setOnline(false);
  try {
    await new MutationObserver(client, createSettingMutationOptions(client, 'u1', 'quietHours', api, notify))
      .mutate({ enabled: false, start: '22:00', end: '07:00' })
      .catch(() => {});
    assert.equal(calls, 1, 'it ran and failed at once instead of pausing');
    assert.equal(cached(client).quietHours.value.enabled, true, 'rolled back');
    const last = notices.at(-1);
    assert.equal(last?.kind === 'failed' && last.reason, 'offline');
  } finally {
    onlineManager.setOnline(true);
  }
  await tick();
  assert.equal(calls, 1, 'reconnecting resumes nothing: no queued write reaches the server');
  assert.equal(client.getMutationCache().getAll().filter((m) => m.state.isPaused).length, 0);
});

test('TEST 14 (connectivity lost while pending): the field stays pending until the request settles; a second change to it is refused', async () => {
  const { client, notify } = setup();
  const wait = deferred<Settings>();
  const options = createSettingMutationOptions(client, 'u1', 'theme', () => ({ change: () => wait.promise }), notify);
  const done = new MutationObserver(client, options).mutate('dark').catch(() => {});
  await tick();
  onlineManager.setOnline(false);
  try {
    const pending = client.isMutating({ mutationKey: settingMutationKey('u1', 'theme') }) > 0;
    assert.equal(pending, true);
    assert.equal(maySaveSetting({ online: onlineManager.isOnline(), pending }), 'busy', 'still disabled, not "offline": it has not settled');
  } finally {
    onlineManager.setOnline(true);
  }
  wait.resolve(settings({ theme: { value: 'dark', updatedAt: '2031-03-04T15:00:00.000Z' } }));
  await done;
  assert.equal(client.isMutating({ mutationKey: settingMutationKey('u1', 'theme') }), 0);
});

// ---- cross-device (app-state.md test 4) ----

test('TEST 4 (cross-device): the foreground refetch brings another device\'s change into the copy this device holds', async () => {
  const client = new QueryClient();
  client.setQueryData<Settings>(KEY, settings());
  let server = settings({ theme: { value: 'dark', updatedAt: '2031-03-04T16:00:00.000Z' } }); // changed on the tablet
  const fetchNow = () => client.fetchQuery({ queryKey: KEY, queryFn: async () => server, staleTime: 0 });
  assert.equal(cached(client).theme.value, 'light', 'this device still shows its old copy');
  await fetchNow(); // what the focus manager does when the app returns to the foreground (staleTime 0)
  assert.equal(cached(client).theme.value, 'dark');
  server = settings({ theme: { value: 'system', updatedAt: '2031-03-04T17:00:00.000Z' } });
  await fetchNow();
  assert.equal(cached(client).theme.value, 'system');
});

// ---- what the screens say ----

test('the Settings header follows what is happening (Figma 108:128, 9:289, 108:2603, 9:258)', () => {
  const change = { key: 'quietHours', value: { enabled: true, start: '22:00', end: '07:00' } } as const;
  assert.deepEqual(settingsHeader({ saving: false, notice: null }), { title: 'Make Rota yours', subtitle: 'Preferences follow you across devices.' });
  assert.equal(settingsHeader({ saving: true, notice: null }).title, 'Saving your change');
  assert.equal(settingsHeader({ saving: true, notice: { kind: 'saved', change } }).title, 'Saving your change', 'saving wins over an old notice');
  assert.deepEqual(settingsHeader({ saving: false, notice: { kind: 'failed', reason: 'error', change, previous: null, requestId: null } }), {
    title: 'Couldn’t save changes',
    subtitle: 'Your previous preference has been restored.',
  });
  assert.equal(settingsHeader({ saving: false, notice: { kind: 'failed', reason: 'offline', change, previous: null, requestId: null } }).title, 'You’re offline');
  assert.deepEqual(settingsHeader({ saving: false, notice: { kind: 'saved', change }, timeZone: 'Africa/Lagos' }), { title: 'Quiet hours saved', subtitle: '22:00 – 07:00 · Africa/Lagos' });
});

test('values are said the way the design says them', () => {
  assert.equal(formatQuietHours({ enabled: true, start: '22:00', end: '07:00' }), '22:00 – 07:00');
  assert.equal(formatQuietHours({ enabled: false, start: '22:00', end: '07:00' }), 'Off');
  assert.equal(describeChange({ key: 'theme', value: 'dark' }), 'Dark');
  assert.equal(describeChange({ key: 'notifyBilling', value: false }), 'Off');
  assert.equal(describeChange({ key: 'language', value: 'en' }), 'English');
  assert.equal(describeChange({ key: 'timeZone', value: null }), 'Choose your time zone');
});

test('typed quiet hours: 24-hour times, sent with two digits, start and end different', () => {
  assert.deepEqual(checkQuietHours({ start: '22:00', end: '06:30' }).values, { start: '22:00', end: '06:30' });
  assert.deepEqual(checkQuietHours({ start: '9:00', end: ' 17:05 ' }).values, { start: '09:00', end: '17:05' });
  assert.equal(checkQuietHours({ start: '25:00', end: '06:00' }).errors.start, 'Enter a time like 22:00.');
  assert.equal(checkQuietHours({ start: '22:00', end: '6' }).errors.end, 'Enter a time like 22:00.');
  assert.equal(checkQuietHours({ start: '', end: '' }).values, null);
  assert.equal(checkQuietHours({ start: '22:00', end: '22:00' }).errors.end, 'Start and end must be different.');
  assert.equal(checkQuietHours({ start: '22:00', end: '22:00' }).values, null);
});

test('the Billing row is for someone who owns a team, by the roles the server returned (in any team, not only the selected one)', () => {
  assert.equal(ownsATeam([{ role: 'owner' }]), true);
  assert.equal(ownsATeam([{ role: 'staff' }, { role: 'owner' }]), true, 'an Owner of one team and Staff in another still sees it');
  assert.equal(ownsATeam([{ role: 'manager' }, { role: 'staff' }]), false);
  assert.equal(ownsATeam([]), false);
  assert.equal(ownsATeam(undefined), false, 'not loaded yet: not shown');
});

// ---- the theme ----

test('which colours: the signed-out side stays light, then the person\'s choice, then the device', () => {
  const r = (override: typeof lightColors | null, preference: 'system' | 'light' | 'dark', deviceScheme: string | null) => resolveColors({ override, preference, deviceScheme });
  assert.equal(r(lightColors, 'dark', 'dark'), lightColors, 'an enclosing override wins: the auth screens are always light (issue #24)');
  assert.equal(r(null, 'dark', 'light'), darkColors);
  assert.equal(r(null, 'light', 'dark'), lightColors);
  assert.equal(r(null, 'system', 'dark'), darkColors);
  assert.equal(r(null, 'system', 'light'), lightColors);
  assert.equal(r(null, 'system', null), lightColors);
});

test('icons follow the theme: in light nothing changes, in dark each baked token colour becomes that token\'s dark colour', () => {
  assert.equal(themeStrokes(navScheduleXml, lightColors, lightColors), navScheduleXml, 'light is identical to the artwork');
  const dark = themeStrokes(statusErrorXml, lightColors, darkColors);
  assert.ok(dark.includes(`stroke="${darkColors.danger}"`), 'the red status icon takes the dark danger colour');
  assert.equal(/stroke="#AF3434"/i.test(dark), false);
  const ink = themeStrokes('<path stroke="#152e2b"/><path stroke="#123456"/>', lightColors, darkColors);
  assert.ok(ink.includes(`stroke="${darkColors.text}"`), 'matching is case-insensitive');
  assert.ok(ink.includes('stroke="#123456"'), 'a colour that is no token is left alone');
});

// ---- client state ----

test('signing out forgets what Settings last said', () => {
  const change = { key: 'theme', value: 'dark' } as const;
  useSessionStore.getState().setSettingsNotice({ kind: 'saved', change });
  assert.equal(useSessionStore.getState().ui.settingsNotice?.kind, 'saved');
  useSessionStore.getState().resetForSignOut('none');
  assert.equal(useSessionStore.getState().ui.settingsNotice, null);
});
