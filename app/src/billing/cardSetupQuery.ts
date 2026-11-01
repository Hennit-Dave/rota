import { OPERATION_POLL_MS } from './operationQuery';
import { cardSetupKey, isCardSetupSettled, type CardSetup } from './billingResponses';

interface CardSetupInput {
  /** The billing API, built on first use (so this file imports nothing from the native app wiring and is unit-tested). */
  api: () => { cardSetup: (teamId: string, setupId: string, signal?: AbortSignal) => Promise<CardSetup> };
  userId: string | undefined;
  teamId: string | null;
  setupId: string | null;
}

/**
 * The query that asks the SERVER about one card-saving attempt, again and again until the server says it is settled. The app never decides that a card was
 * saved. Pure, like `operationQueryOptions`: it asks and returns, and invalidates nothing under ['billing', user, team] (that prefix includes this very query).
 */
export function cardSetupQueryOptions(input: CardSetupInput) {
  const { api, userId, teamId, setupId } = input;
  return {
    queryKey: cardSetupKey(userId ?? '', teamId ?? '', setupId ?? ''),
    enabled: userId !== undefined && teamId !== null && setupId !== null,
    networkMode: 'always' as const,
    retry: false as const,
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<CardSetup> => api().cardSetup(teamId as string, setupId as string, signal),
    refetchInterval: (query: { state: { data: CardSetup | undefined } }) => (query.state.data && isCardSetupSettled(query.state.data.status) ? false : OPERATION_POLL_MS),
  };
}
