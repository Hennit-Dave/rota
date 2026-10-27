import type { ActivityItem, ActivityPage } from './activityResponses';

/** The infinite query's data: pages in the order they were fetched, with the cursor each was fetched with. */
export interface Pages {
  pages: ActivityPage[];
  pageParams: Array<string | null>;
}

/** The cursor for the page after `last`, or `undefined` when there is none (that is how TanStack Query learns the list has ended). */
export const nextPageParam = (last: ActivityPage): string | undefined => last.nextCursor ?? undefined;

/**
 * Whether scrolling to the end may ask for another page. Only when there IS a next page, none is on its way (fast scrolling fires the end-reached event
 * many times: this is what keeps it from sending duplicate requests, app-state.md test 16), and the last attempt did not fail (otherwise a failed page
 * would be asked for again in a loop; the person taps "Try again" instead).
 */
export function mayFetchNextPage(state: { hasNextPage: boolean; isFetchingNextPage: boolean; isFetchNextPageError: boolean }): boolean {
  return state.hasNextPage && !state.isFetchingNextPage && !state.isFetchNextPageError;
}

/**
 * The rows of every loaded page in feed order. A row that appears twice (the same row served on two pages) is shown once: the list's key is the row's ID,
 * and a repeated key would confuse the list. The server's cursor paging does not repeat rows; this only protects the screen.
 */
export function flattenPages(data: Pages | undefined): ActivityItem[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const page of data.pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/**
 * Pull to refresh asks for the newest rows again. Refetching an infinite query refetches EVERY loaded page one after another, which after a long scroll is
 * many requests; the feed's newest rows are all that changed, so refreshing starts again from page one: keep only the first page, then refetch.
 */
export function keepFirstPage(data: Pages | undefined): Pages | undefined {
  if (!data || data.pages.length <= 1) return data;
  return { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) };
}

export type FeedState = 'loading' | 'error' | 'empty' | 'items';

/**
 * Which of the screen's four bodies to show. Rows already on screen stay (an error after them is the footer's job). With no rows yet:
 * - an error is an error;
 * - a request on its way is loading;
 * - NEITHER is a query TanStack has left idle or paused (a retry paused because the app is not in the foreground, or a fetch that was cancelled). It
 *   will not start by itself, so showing the skeleton would wait for ever: it is shown as an error with "Try again", which starts it again.
 */
export function feedState(input: { hasData: boolean; itemCount: number; isError: boolean; isFetching: boolean }): FeedState {
  if (input.hasData) return input.itemCount === 0 ? 'empty' : 'items';
  if (input.isError) return 'error';
  return input.isFetching ? 'loading' : 'error';
}
