import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MutationObserver, QueryClient } from '@tanstack/query-core';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { ApiError, NetworkError, OfflineError, type Logger } from '../api/errors';
import { AccountEpoch } from '../auth/epoch';
import { savedShiftsApply } from './fallback';
import { formatLastUpdated, upcomingDays } from './lastUpdated';
import { OFFLINE_MAX_AGE_MS, isExpired } from './offlineConfig';
import { createOfflineSaving } from './offlineSaving';
import { parseSavedRow, serializeSavedRow, type OfflineStore, type SavedRow } from './offlineStore';
import { parseUpcoming, upcomingKey, type Upcoming } from './upcoming';

const DAY = 24 * 60 * 60 * 1000;
// The real clock: setQueryData stamps a query with it, and the saving code compares that stamp with its own clock.
const T0 = Date.now();

const upcoming = (asOf = '2031-03-04T12:00:00.000Z'): Upcoming => ({
  asOf,
  team: { name: 'The Olive Room', timeZone: 'Europe/London' },
  shifts: [{ id: 's1', title: 'Morning service', area: 'Front of house', startsAt: '2031-03-05T09:00:00.000Z', endsAt: '2031-03-05T17:00:00.000Z' }],
});

// ---- the answer from the server --------------------------------------------------------------------------------

test('parseUpcoming keeps only what the offline screen draws: the note, the break and the assignee never reach the cache, so they are never saved', () => {
  const parsed = parseUpcoming({
    asOf: '2031-03-04T12:00:00.000Z',
    team: { name: 'The Olive Room', timeZone: 'Europe/London', createdAt: 'x' },
    shifts: [{ id: 's1', title: 'Morning', area: null, startsAt: '2031-03-05T09:00:00.000Z', endsAt: '2031-03-05T17:00:00.000Z', breakMinutes: 30, note: 'Briefing', assignee: { id: 'u1', name: 'Sam' }, status: 'scheduled' }],
  });
  assert.deepEqual(parsed, {
    asOf: '2031-03-04T12:00:00.000Z',
    team: { name: 'The Olive Room', timeZone: 'Europe/London' },
    shifts: [{ id: 's1', title: 'Morning', area: null, startsAt: '2031-03-05T09:00:00.000Z', endsAt: '2031-03-05T17:00:00.000Z' }],
  });
});

test('parseUpcoming refuses an answer it cannot read in full, including a time zone this phone cannot use', () => {
  const ok = { asOf: '2031-03-04T12:00:00.000Z', team: { name: 'T', timeZone: 'UTC' }, shifts: [] };
  assert.deepEqual(parseUpcoming(ok).shifts, []);
  for (const bad of [
    null,
    { ...ok, asOf: 'yesterday' },
    { ...ok, asOf: undefined },
    { ...ok, team: { name: 'T' } },
    { ...ok, team: { name: 'T', timeZone: 'Mars/Olympus' } },
    { ...ok, shifts: 'none' },
    { ...ok, shifts: [{ id: 's', title: 'x', area: null, startsAt: 'nope', endsAt: '2031-03-05T17:00:00.000Z' }] },
  ]) {
    assert.throws(() => parseUpcoming(bad), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
  }
});

// ---- when the saved copy may be shown --------------------------------------------------------------------------

test('savedShiftsApply: offline, unreachable or unwell yes; a server that ANSWERED with a refusal never', () => {
  assert.equal(savedShiftsApply({ error: new OfflineError(), online: true }), true);
  assert.equal(savedShiftsApply({ error: undefined, online: false }), true, 'the phone says it is offline');
  assert.equal(savedShiftsApply({ error: new NetworkError('timeout', true), online: true }), true);
  for (const status of [500, 502, 503, 429]) assert.equal(savedShiftsApply({ error: new ApiError(status, 'x', 'x', null), online: true }), true, String(status));
  for (const status of [400, 401, 403, 404]) assert.equal(savedShiftsApply({ error: new ApiError(status, 'x', 'x', null), online: false }), false, String(status));
  assert.equal(savedShiftsApply({ error: undefined, online: true }), false, 'still loading: no saved data in its place');
  assert.equal(savedShiftsApply({ error: new Error('bug'), online: true }), false);
});

test('the maximum age is 7 days, counted from the fetch', () => {
  assert.equal(OFFLINE_MAX_AGE_MS, 7 * DAY);
  assert.equal(isExpired(T0, T0 + 7 * DAY), false, 'exactly seven days is still inside');
  assert.equal(isExpired(T0, T0 + 7 * DAY + 1), true);
});

// ---- what the screen shows -------------------------------------------------------------------------------------

test('"last updated" is the SERVER\'s time, in the team\'s clock', () => {
  assert.equal(formatLastUpdated('2031-03-04T12:05:00.000Z', 'Europe/London'), 'Tuesday, 4 March, 12:05');
  assert.equal(formatLastUpdated('2031-03-04T23:30:00.000Z', 'Asia/Tokyo'), 'Wednesday, 5 March, 08:30');
  assert.equal(formatLastUpdated('not a time', 'UTC'), null);
});

test('upcomingDays drops shifts that ended while the phone was offline, sorts, and groups by the day each starts on in the team\'s zone', () => {
  const s = (id: string, startsAt: string, endsAt: string) => ({ id, title: id, area: null, startsAt, endsAt });
  const days = upcomingDays(
    [
      s('late', '2031-03-06T09:00:00Z', '2031-03-06T17:00:00Z'),
      s('over', '2031-03-04T06:00:00Z', '2031-03-04T11:00:00Z'),
      s('now', '2031-03-04T11:00:00Z', '2031-03-04T13:00:00Z'),
      s('night', '2031-03-05T23:30:00Z', '2031-03-06T07:00:00Z'),
    ],
    new Date('2031-03-04T12:00:00Z'),
    'Asia/Tokyo', // UTC+9: 23:30Z on the 5th is 08:30 on the 6th there
  );
  assert.deepEqual(days.map((d) => [d.key, d.shifts.map((x) => x.id)]), [
    ['2031-03-04', ['now']],
    ['2031-03-06', ['night', 'late']],
  ]);
});

// ---- the row on disk -------------------------------------------------------------------------------------------

test('parseSavedRow accepts what we wrote and nothing else', () => {
  const client: PersistedClient = { timestamp: 1, buster: 'u1', clientState: { mutations: [], queries: [] } };
  assert.deepEqual(parseSavedRow(serializeSavedRow('u1', client)), { userId: 'u1', client });
  for (const bad of ['', 'not json', '[]', 'null', '{}', JSON.stringify({ userId: '', client }), JSON.stringify({ userId: 'u1' }), JSON.stringify({ userId: 'u1', client: { timestamp: 'x' } })]) {
    assert.equal(parseSavedRow(bad), null, bad);
  }
});

// ---- saving and restoring --------------------------------------------------------------------------------------

/** A store that behaves like the disk: what comes back went through text, so nothing live can leak across. */
function fakeStore(opts: { saveDelayMs?: number; failSave?: boolean } = {}) {
  let text: string | null = null;
  const log = { saves: 0, clears: 0 };
  const store: OfflineStore = {
    load: async () => (text === null ? null : parseSavedRow(text)),
    save: async (userId, client) => {
      if (opts.failSave) throw new Error('disk full');
      if (opts.saveDelayMs) await new Promise((r) => setTimeout(r, opts.saveDelayMs));
      text = serializeSavedRow(userId, client);
      log.saves += 1;
    },
    clear: async () => {
      text = null;
      log.clears += 1;
    },
  };
  return { store, log, row: (): SavedRow | null => (text === null ? null : parseSavedRow(text)) };
}

function setup(store: OfflineStore, over: { now?: () => number; epoch?: AccountEpoch } = {}) {
  const warnings: string[] = [];
  const logger: Logger = { warn: (event) => void warnings.push(event) };
  const queryClient = new QueryClient();
  const epoch = over.epoch ?? new AccountEpoch();
  const saving = createOfflineSaving({ queryClient, store, epoch, maxAgeMs: OFFLINE_MAX_AGE_MS, logger, now: over.now ?? (() => T0) });
  return { queryClient, epoch, saving, warnings };
}

const settle = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));
const savedKeys = (row: SavedRow | null) => (row?.client.clientState.queries ?? []).map((q) => q.queryKey);

test('app-state test 7: only the upcoming-shifts query is saved, never another query, and never a mutation', async () => {
  const disk = fakeStore();
  const { queryClient, saving } = setup(disk.store);
  await saving.begin('u1');
  queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming());
  queryClient.setQueryData(['settings', 'u1'], { theme: 'dark' });
  queryClient.setQueryData(['billing', 'u1', 't1'], { total: '$50.00' });
  queryClient.setQueryData(['me'], { id: 'u1', name: 'Sam', email: 'sam@example.com' });
  queryClient.setQueryData(['shifts', 'u1', 't1', 'range', 'a', 'b', 'all'], []);
  await new MutationObserver(queryClient, { mutationKey: ['swap'], mutationFn: async () => 'sent' }).mutate();
  await settle();

  const row = disk.row();
  assert.equal(row?.userId, 'u1');
  assert.deepEqual(savedKeys(row), [upcomingKey('u1', 't1')]);
  assert.deepEqual(row?.client.clientState.mutations, []);
  assert.equal(JSON.stringify(row).includes('$50.00') || JSON.stringify(row).includes('sam@example.com') || JSON.stringify(row).includes('dark'), false);
});

test('after a restart the saved shifts are put back with their original fetch time; saving carries on for the same person', async () => {
  const disk = fakeStore();
  const first = setup(disk.store);
  await first.saving.begin('u1');
  first.queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming(), { updatedAt: T0 - 1000 });
  await settle();

  const second = setup(disk.store); // a new process: an empty cache, the same disk
  await second.saving.restoreOnStart();
  const query = second.queryClient.getQueryCache().find({ queryKey: upcomingKey('u1', 't1') });
  assert.deepEqual(query?.state.data, upcoming());
  assert.equal(query?.state.dataUpdatedAt, T0 - 1000, 'the age counts from the fetch, not from the restart');

  second.queryClient.setQueryData(upcomingKey('u1', 't1'), { ...upcoming('2031-03-04T13:00:00.000Z') });
  await settle();
  assert.equal((disk.row()?.client.clientState.queries[0]?.state.data as Upcoming).asOf, '2031-03-04T13:00:00.000Z', 'still saving for the owner');
});

test('a copy older than 7 days is deleted at start, not shown', async () => {
  const disk = fakeStore();
  const first = setup(disk.store);
  await first.saving.begin('u1');
  first.queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming(), { updatedAt: T0 });
  await settle();
  assert.ok(disk.row());

  const later = setup(disk.store, { now: () => T0 + 7 * DAY + 1 });
  await later.saving.restoreOnStart();
  assert.equal(later.queryClient.getQueryCache().find({ queryKey: upcomingKey('u1', 't1') }), undefined);
  assert.equal(disk.row(), null);
});

test('the age does not slide: reopening the app does not make an old copy young again', async () => {
  const disk = fakeStore();
  const first = setup(disk.store);
  await first.saving.begin('u1');
  first.queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming(), { updatedAt: T0 });
  await settle();

  // Day 6: opened, nothing new fetched. The row is saved again (a later "timestamp"), but the data's own age is unchanged.
  const day6 = setup(disk.store, { now: () => T0 + 6 * DAY });
  await day6.saving.restoreOnStart();
  day6.queryClient.invalidateQueries({ queryKey: ['upcoming-shifts'] });
  await settle();
  assert.equal(disk.row()?.client.clientState.queries[0]?.state.dataUpdatedAt, T0);

  const day8 = setup(disk.store, { now: () => T0 + 8 * DAY });
  await day8.saving.restoreOnStart();
  assert.equal(day8.queryClient.getQueryCache().findAll({ queryKey: ['upcoming-shifts'] }).length, 0);
  assert.equal(disk.row(), null);
});

test('another person signing in finds nothing of the previous person\'s: the copy is wiped from the cache and the device before anything is saved for them', async () => {
  const disk = fakeStore();
  const a = setup(disk.store);
  await a.saving.begin('userA');
  a.queryClient.setQueryData(upcomingKey('userA', 't1'), upcoming());
  await settle();
  assert.equal(disk.row()?.userId, 'userA');

  // The same process restores A's copy, then B signs in without the sign-out having cleaned up (a failed step).
  const b = setup(disk.store);
  await b.saving.restoreOnStart();
  assert.equal(b.queryClient.getQueryCache().findAll({ queryKey: ['upcoming-shifts'] }).length, 1);
  await b.saving.begin('userB');
  assert.equal(b.queryClient.getQueryCache().findAll({ queryKey: ['upcoming-shifts'] }).length, 0);
  assert.equal(disk.row(), null);

  b.queryClient.setQueryData(upcomingKey('userB', 't9'), upcoming());
  await settle();
  assert.equal(disk.row()?.userId, 'userB');
  assert.deepEqual(savedKeys(disk.row()), [upcomingKey('userB', 't9')]);
});

test('the same person signing in again keeps their copy', async () => {
  const disk = fakeStore();
  const a = setup(disk.store);
  await a.saving.begin('u1');
  a.queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming());
  await settle();
  const b = setup(disk.store);
  await b.saving.restoreOnStart();
  await b.saving.begin('u1');
  assert.equal(b.queryClient.getQueryCache().findAll({ queryKey: ['upcoming-shifts'] }).length, 1);
  assert.ok(disk.row());
});

test('app-state test 8: sign-out leaves the saved shifts empty, and later changes are not saved', async () => {
  const disk = fakeStore();
  const { queryClient, epoch, saving } = setup(disk.store);
  await saving.begin('u1');
  queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming());
  await settle();
  assert.ok(disk.row());

  epoch.bump(); // signOut.ts bumps first, then clears the caches, then this step
  queryClient.clear();
  await saving.stopAndClear();
  assert.equal(disk.row(), null);

  queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming());
  await settle();
  assert.equal(disk.row(), null, 'nothing subscribes any more');
});

test('app-state test 9: a save that was already on its way when the account changed never lands after the clear', async () => {
  const disk = fakeStore({ saveDelayMs: 40 });
  const { queryClient, epoch, saving } = setup(disk.store);
  await saving.begin('userA');
  queryClient.setQueryData(upcomingKey('userA', 't1'), upcoming()); // save 1 starts
  queryClient.setQueryData(upcomingKey('userA', 't1'), upcoming('2031-03-04T12:30:00.000Z')); // save 2 waits behind it
  await settle(10);

  epoch.bump(); // sign out while A's writes are in flight
  queryClient.clear();
  await saving.stopAndClear();
  await settle(120);
  assert.equal(disk.row(), null, 'neither the running save nor the waiting one survives the clear');
  assert.ok(disk.log.saves <= 1, 'the waiting save saw the new epoch and wrote nothing');

  // B signs in afterwards and saves normally.
  await saving.begin('userB');
  queryClient.setQueryData(upcomingKey('userB', 't2'), upcoming());
  await settle(120);
  assert.equal(disk.row()?.userId, 'userB');
});

test('a store that fails never throws into the app: it is logged by event name and the app simply has no saved copy', async () => {
  const disk = fakeStore({ failSave: true });
  const { queryClient, saving, warnings } = setup(disk.store);
  await saving.begin('u1');
  queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming());
  await settle();
  assert.ok(warnings.includes('offline_save_failed'));
  assert.equal(disk.row(), null);

  const broken: OfflineStore = { load: async () => Promise.reject(new Error('x')), save: async () => {}, clear: async () => Promise.reject(new Error('x')) };
  const other = setup(broken);
  await other.saving.restoreOnStart();
  await other.saving.begin('u1');
  await other.saving.stopAndClear();
  assert.deepEqual(other.warnings.filter((w) => w.startsWith('offline_')), ['offline_load_failed', 'offline_load_failed', 'offline_clear_failed']);
});

test('a refetch that FAILS (offline) keeps the saved copy: the data is still there, so it is still saved (found on the emulator: the first offline start emptied the row)', async () => {
  const disk = fakeStore();
  const { queryClient, saving } = setup(disk.store);
  await saving.begin('u1');
  queryClient.setQueryData(upcomingKey('u1', 't1'), upcoming());
  await settle();
  assert.equal(savedKeys(disk.row()).length, 1);

  // What the schedule does on an offline start: ask again, fail at once. The query's status becomes 'error' but its data stays.
  await queryClient.fetchQuery({ queryKey: upcomingKey('u1', 't1'), queryFn: () => Promise.reject(new Error('offline')), staleTime: 0, retry: false }).catch(() => undefined);
  assert.equal(queryClient.getQueryState(upcomingKey('u1', 't1'))?.status, 'error');
  await settle();
  assert.deepEqual(savedKeys(disk.row()), [upcomingKey('u1', 't1')], 'the copy on disk is not emptied by a failed refresh');

  // And the next start still finds it.
  const next = setup(disk.store);
  await next.saving.restoreOnStart();
  assert.deepEqual((next.queryClient.getQueryData(upcomingKey('u1', 't1')) as Upcoming).team.name, 'The Olive Room');
});
