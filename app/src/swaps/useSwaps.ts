import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activityKey } from '../activity/activityResponses';
import { getSwapApi } from '../services';
import { shiftsPrefix } from '../shifts/shiftResponses';
import { updateSwap } from './swapOptimistic';
import { createSwapMutationOptions } from './swapMutation';
import { swapsKey, type Swap } from './swapResponses';

/**
 * The caller's swaps (and, for an Owner or Manager, every swap waiting for a decision). Server data, personal and team-scoped, so the key carries the user ID
 * and the team ID (app-state.md). TanStack's defaults (stale at once, refetched on mount and on return to the foreground): a request can be decided at any
 * moment. `networkMode: 'always'` so offline it fails at once into the error state instead of pausing for ever. No number is invented (docs/STATE.md).
 */
export function useSwaps(userId: string | undefined, teamId: string | null) {
  return useQuery({
    queryKey: swapsKey(userId ?? '', teamId ?? ''),
    enabled: userId !== undefined && teamId !== null,
    networkMode: 'always',
    queryFn: ({ signal }) => getSwapApi().list(teamId as string, signal),
  });
}

/** One swap. It opens instantly from the list the screen already holds, then the server's answer replaces it. */
export function useSwap(userId: string | undefined, teamId: string | null, swapId: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: [...swapsKey(userId ?? '', teamId ?? ''), 'one', swapId] as const,
    enabled: userId !== undefined && teamId !== null && !swapId.startsWith('optimistic-'),
    networkMode: 'always',
    queryFn: ({ signal }) => getSwapApi().get(teamId as string, swapId, signal),
    initialData: () => (userId === undefined || teamId === null ? undefined : client.getQueryData<Swap[]>(swapsKey(userId, teamId))?.find((s) => s.id === swapId)),
    // The list's copy may be older than the server's: ask again as soon as the screen opens.
    initialDataUpdatedAt: 0,
  });
}

export function useCreateSwap(userId: string | undefined, teamId: string | null) {
  const client = useQueryClient();
  return useMutation(createSwapMutationOptions(client, userId, teamId, getSwapApi));
}

/**
 * Cancel, approve and reject. One request the person watches: not optimistic (the server decides what happens to two people's shifts), never queued offline
 * and never retried. An approval changes who works two shifts, so it also drops the cached shifts and the feed.
 */
export function useSwapActions(userId: string | undefined, teamId: string | null) {
  const client = useQueryClient();
  const key = swapsKey(userId ?? '', teamId ?? '');
  const settled = (answer: Swap | undefined) => {
    if (userId === undefined || teamId === null) return;
    if (answer) {
      client.setQueryData<Swap[] | undefined>(key, (list) => updateSwap(list, answer));
      client.setQueryData([...key, 'one', answer.id], answer);
    }
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: shiftsPrefix(userId, teamId) });
    void client.invalidateQueries({ queryKey: activityKey(userId, teamId) });
  };
  const common = { networkMode: 'always' as const, retry: 0 };
  const cancel = useMutation({ ...common, mutationFn: (swapId: string) => getSwapApi().cancel(teamId as string, swapId), onSuccess: settled, onError: () => settled(undefined) });
  const decide = useMutation({
    ...common,
    mutationFn: (v: { swapId: string; decision: 'approve' | 'reject' }) => getSwapApi().decide(teamId as string, v.swapId, v.decision),
    onSuccess: settled,
    // A refused or stale decision: the list the person holds is out of date, so ask again.
    onError: () => settled(undefined),
  });
  return { cancel, decide };
}
