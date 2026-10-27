import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { getActivityApi } from '../services';
import { activityKey, type ActivityPage } from './activityResponses';
import { keepFirstPage, nextPageParam, type Pages } from './activityPaging';

/**
 * The team's feed, newest first, one page at a time with the server's cursor. Server data, personal and team-scoped, so the key carries the user ID and the
 * team ID (app-state.md). TanStack's defaults (stale at once, refetched on mount and on return to the foreground): the feed is what just happened, so
 * nothing here shows a list the server may no longer agree with. `networkMode: 'always'` so offline it fails at once into the error state instead of pausing
 * for ever. No number is invented (docs/STATE.md). The first page asks for no `limit`: the server's default (20) is the page size.
 */
export function useActivity(userId: string | undefined, teamId: string | null) {
  const client = useQueryClient();
  const key = activityKey(userId ?? '', teamId ?? '');
  const query = useInfiniteQuery<ActivityPage, Error, Pages, ReturnType<typeof activityKey>, string | null>({
    queryKey: key,
    enabled: userId !== undefined && teamId !== null,
    networkMode: 'always',
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => getActivityApi().list(teamId as string, { cursor: pageParam }, signal),
    getNextPageParam: nextPageParam,
  });

  /** Pull to refresh: start again from page one (see `keepFirstPage`), then ask the server. */
  const refresh = async () => {
    client.setQueryData<Pages | undefined>(key, keepFirstPage);
    await query.refetch();
  };
  /**
   * "Try again" after a failed first load: start from nothing. `refetch()` would only nudge a query that is paused or idle (and a paused retry stays paused
   * while the app is not focused); resetting the query throws that state away and fetches page one again.
   */
  const retry = () => void client.resetQueries({ queryKey: key });
  return { ...query, refresh, retry };
}
