import type { createApiClient } from '../api/client';
import { parseSwapList, parseSwapResponse, type Swap } from './swapResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'post'>;

const base = (teamId: string) => `/teams/${encodeURIComponent(teamId)}/swaps`;

/** The swap routes (docs/ARCHITECTURE.md 5f). Plain functions over the API client, so they are unit-tested without a screen. */
export function createSwapApi(client: Client) {
  return {
    /** GET: the caller's own swaps, and for an Owner or Manager every swap waiting for a decision. */
    async list(teamId: string, signal?: AbortSignal): Promise<Swap[]> {
      return parseSwapList(await client.get<unknown>(base(teamId), { signal }));
    },
    async get(teamId: string, swapId: string, signal?: AbortSignal): Promise<Swap> {
      return parseSwapResponse(await client.get<unknown>(`${base(teamId)}/${encodeURIComponent(swapId)}`, { signal }));
    },
    /**
     * POST: ask to swap `offeredShiftId` (the caller's own) for `requestedShiftId`. WHO is asking and who the other person is are never sent: the server
     * knows. `idempotencyKey` is made once per request by the screen: a retry after a timeout sends the SAME key, so the server returns the stored swap
     * instead of creating a second one (the app's disabled button alone cannot stop a network retry).
     */
    async create(teamId: string, input: { offeredShiftId: string; requestedShiftId: string }, idempotencyKey: string): Promise<Swap> {
      return parseSwapResponse(await client.post<unknown>(base(teamId), input, { headers: { 'Idempotency-Key': idempotencyKey } }));
    },
    async cancel(teamId: string, swapId: string): Promise<Swap> {
      return parseSwapResponse(await client.post<unknown>(`${base(teamId)}/${encodeURIComponent(swapId)}/cancel`));
    },
    /** An Owner or Manager decides. The server refuses anyone else, and a person who is part of the swap. */
    async decide(teamId: string, swapId: string, decision: 'approve' | 'reject'): Promise<Swap> {
      return parseSwapResponse(await client.post<unknown>(`${base(teamId)}/${encodeURIComponent(swapId)}/${decision}`));
    },
  };
}
