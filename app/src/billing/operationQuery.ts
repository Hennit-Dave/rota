import type { QueryClient } from '@tanstack/query-core';
import { teamDetailQueryKey } from '../teams/teamResponses';
import { billingKey, historyKey, isSettled, operationKey, type Operation } from './billingResponses';

/**
 * How often the payment screen asks the server whether the payment is settled, in milliseconds. CHOSEN, NOT MEASURED (docs/STATE.md): short enough that
 * "confirming" resolves soon after Stripe's webhook has been processed, long enough not to hammer the API. Polling stops as soon as the server says settled.
 */
export const OPERATION_POLL_MS = 3000;

interface OperationInput {
  /** The billing API, built on first use (so this file imports nothing from the native app wiring and is unit-tested). */
  api: () => { operation: (teamId: string, operationId: string, signal?: AbortSignal) => Promise<Operation> };
  userId: string | undefined;
  teamId: string | null;
  operationId: string | null;
}

/** The query that asks the SERVER about one payment, again and again until the server says it is settled. The app never decides that a payment succeeded. */
export function operationQueryOptions(client: QueryClient, input: OperationInput) {
  const { api, userId, teamId, operationId } = input;
  return {
    queryKey: operationKey(userId ?? '', teamId ?? '', operationId ?? ''),
    enabled: userId !== undefined && teamId !== null && operationId !== null,
    networkMode: 'always' as const,
    retry: false as const,
    // Pure: it asks and returns. It must NOT invalidate anything under ['billing', user, team]: that prefix includes this very query, and invalidating a
    // query while it is fetching (once it holds data) cancels that fetch and starts another, so the answer never lands and the screen sticks on its old status.
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<Operation> => api().operation(teamId as string, operationId as string, signal),
    refetchInterval: (query: { state: { data: Operation | undefined } }) => (query.state.data && isSettled(query.state.data.status) ? false : OPERATION_POLL_MS),
  };
}

/**
 * The server just said this payment is settled, so the subscription (and what the team may do) may have changed: ask for the billing overview and the team
 * detail again. `exact` on the overview, so the payment's own query (and any quote) under the same prefix is left alone.
 */
export function refreshAfterSettled(client: QueryClient, userId: string, teamId: string): void {
  void client.invalidateQueries({ queryKey: billingKey(userId, teamId), exact: true });
  void client.invalidateQueries({ queryKey: historyKey(userId, teamId), exact: true });
  void client.invalidateQueries({ queryKey: teamDetailQueryKey(userId, teamId) });
}
