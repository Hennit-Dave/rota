import type { MutationOptions, QueryClient } from '@tanstack/query-core';
import { activityKey } from '../activity/activityResponses';
import type { Shift } from '../shifts/shiftResponses';
import type { createSwapApi } from './swapApi';
import { optimisticSwap, optimisticSwapId, replaceSwap, withOptimisticSwap } from './swapOptimistic';
import { swapsKey, type Swap } from './swapResponses';

export interface CreateSwapInput {
  /** The caller's own shift, and the teammate's shift they would receive: both as the screens hold them. */
  offered: Shift;
  requested: Shift;
  /** Made once per request by the confirm screen; a retry of the same request sends the same key (the server returns the stored swap). */
  key: string;
  me: { id: string; name: string };
}

/**
 * The options of "Send swap request": an optimistic update with rollback (app-state.md, brief Requirement 2).
 * 1. `onMutate` cancels what is in flight for the swaps, keeps the list as it was, and puts the guess on top;
 * 2. `onError` puts the list back as it was (the screen says why);
 * 3. `onSuccess` swaps the guess for the server's own answer, and `onSettled` asks the server again, so the guess never stays.
 * Never queued offline and never retried: `networkMode: 'always'` and `retry: 0`, no mutation `scope`; the screen checks connectivity before it calls this.
 * A factory over plain dependencies so the whole lifecycle is tested without a screen.
 */
export function createSwapMutationOptions(
  client: QueryClient,
  userId: string | undefined,
  teamId: string | null,
  api: () => Pick<ReturnType<typeof createSwapApi>, 'create'>,
): MutationOptions<Swap, unknown, CreateSwapInput, { previous: Swap[] | undefined }> {
  const key = swapsKey(userId ?? '', teamId ?? '');
  return {
    networkMode: 'always',
    retry: 0,
    mutationFn: (input) => api().create(teamId as string, { offeredShiftId: input.offered.id, requestedShiftId: input.requested.id }, input.key),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      const previous = client.getQueryData<Swap[]>(key);
      const guess = optimisticSwap({ key: input.key, me: input.me, offered: input.offered, requested: input.requested, now: new Date() });
      if (guess) client.setQueryData<Swap[]>(key, withOptimisticSwap(previous, guess));
      return { previous };
    },
    onError: (_error, _input, context) => {
      // `setQueryData(key, undefined)` does nothing, so "there was no list before" is a removal.
      if (context?.previous === undefined) client.removeQueries({ queryKey: key, exact: true });
      else client.setQueryData<Swap[]>(key, context.previous);
    },
    onSuccess: (swap, input) => {
      client.setQueryData<Swap[]>(key, (list) => replaceSwap(list, optimisticSwapId(input.key), swap));
    },
    onSettled: () => {
      if (userId === undefined || teamId === null) return;
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: activityKey(userId, teamId) });
    },
  };
}
