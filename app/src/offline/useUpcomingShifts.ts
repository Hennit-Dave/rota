import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getShiftApi } from '../services';
import { UPCOMING_ROOT, upcomingKey, type Upcoming, type UpcomingKey } from './upcoming';

/**
 * The saved copy that is already in the cache (put back from the device at app start) and belongs to this person; the newest if there is more than one.
 * When nobody is known yet (an offline start: `/auth/me` could not be asked) any copy qualifies, because the device only ever holds one person's and
 * sign-out deletes it.
 */
export function firstSavedKey(client: QueryClient, userId: string | undefined): UpcomingKey | null {
  const found = client
    .getQueryCache()
    .findAll({ queryKey: [UPCOMING_ROOT] })
    .filter((q) => q.state.data !== undefined && q.queryKey.length === 3 && (userId === undefined || q.queryKey[1] === userId))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0];
  return found ? (found.queryKey as unknown as UpcomingKey) : null;
}

/**
 * The person's own upcoming shifts for the selected team (GET /teams/:id/shifts/upcoming). It is the one query that is saved on the device, so it refreshes
 * whenever the schedule is open and the phone can reach the server (stale at once, like the rest: `docs/STATE.md`). Offline it fails at once
 * (`networkMode: 'always'`) and the data already held, fresh or restored, stays. Its `gcTime` is the maximum age, set in `services.ts`, so a restored copy is not dropped from memory.
 */
export function useUpcomingShifts(userId: string | undefined, teamId: string | null) {
  const client = useQueryClient();
  const key = useMemo<UpcomingKey | null>(
    () => (userId !== undefined && teamId !== null ? upcomingKey(userId, teamId) : firstSavedKey(client, userId)),
    [client, userId, teamId],
  );
  return useQuery({
    queryKey: key ?? ([UPCOMING_ROOT, 'none', 'none'] as const),
    enabled: key !== null,
    networkMode: 'always',
    queryFn: ({ signal }): Promise<Upcoming> => getShiftApi().upcoming((key as UpcomingKey)[2], signal),
  });
}
