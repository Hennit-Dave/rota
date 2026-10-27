import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activityKey } from '../activity/activityResponses';
import { getShiftApi } from '../services';
import type { ShiftInput } from './shiftApi';
import { shiftKey, shiftsPrefix, shiftsRangeKey, type Shift } from './shiftResponses';

/**
 * The shifts that overlap `[from, to)`. Server data, personal and team-scoped, so the key carries the user ID and the team ID (app-state.md). TanStack's
 * defaults (stale at once, refetched on mount and on return to the foreground): a manager can publish at any moment and nothing here may show a week the
 * server no longer agrees with. `networkMode: 'always'` so offline the request fails at once into the offline state instead of pausing for ever
 * (saved shifts arrive with the offline slice). No number is invented (docs/STATE.md).
 */
export function useShiftsRange(userId: string | undefined, teamId: string | null, range: { from: Date; to: Date }, mine: boolean) {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  return useQuery({
    queryKey: shiftsRangeKey(userId ?? '', teamId ?? '', from, to, mine ? 'mine' : 'all'),
    enabled: userId !== undefined && teamId !== null,
    networkMode: 'always',
    queryFn: ({ signal }) => getShiftApi().list(teamId as string, { from, to, mine }, signal),
  });
}

/**
 * One shift. It opens instantly from the range the schedule already holds, then the server answer replaces it. A shift that was deleted comes back as a
 * 404, which the screen shows as "isn't available".
 */
export function useShift(userId: string | undefined, teamId: string | null, shiftId: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: shiftKey(userId ?? '', teamId ?? '', shiftId),
    enabled: userId !== undefined && teamId !== null,
    networkMode: 'always',
    queryFn: ({ signal }) => getShiftApi().get(teamId as string, shiftId, signal),
    initialData: () => {
      if (userId === undefined || teamId === null) return undefined;
      for (const [, data] of client.getQueriesData<Shift[]>({ queryKey: [...shiftsPrefix(userId, teamId), 'range'] })) {
        const found = data?.find((shift) => shift.id === shiftId);
        if (found) return found;
      }
      return undefined;
    },
    // initialData from a list may be older than the server: ask again as soon as the screen opens.
    initialDataUpdatedAt: 0,
  });
}

/**
 * The three writes. None is queued offline and none is retried (app-state.md): each is one request the person watches. After a write the cached ranges
 * are dropped so every week reads the server again, and the server's own answer for a created or edited shift seeds the single-shift entry.
 */
export function useShiftMutations(userId: string | undefined, teamId: string | null) {
  const client = useQueryClient();
  const refresh = () => {
    if (userId === undefined || teamId === null) return;
    void client.invalidateQueries({ queryKey: shiftsPrefix(userId, teamId) });
    // Every shift write also wrote a feed row (ADR 0021): the feed the app holds is now missing its newest line.
    void client.invalidateQueries({ queryKey: activityKey(userId, teamId) });
  };
  const seed = (shift: Shift) => {
    if (userId !== undefined && teamId !== null) client.setQueryData(shiftKey(userId, teamId, shift.id), shift);
  };

  const create = useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: (input: ShiftInput) => getShiftApi().create(teamId as string, input),
    onSuccess: (shift) => {
      seed(shift);
      refresh();
    },
  });
  const update = useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: (vars: { shiftId: string; changes: Partial<ShiftInput> }) => getShiftApi().update(teamId as string, vars.shiftId, vars.changes),
    onSuccess: (shift) => {
      seed(shift);
      refresh();
    },
  });
  const remove = useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: (shiftId: string) => getShiftApi().remove(teamId as string, shiftId),
    onSuccess: (_void, shiftId) => {
      if (userId !== undefined && teamId !== null) client.removeQueries({ queryKey: shiftKey(userId, teamId, shiftId) });
      refresh();
    },
    // A 404 means it is already gone: the schedule must stop showing it too.
    onError: refresh,
  });
  return { create, update, remove };
}
