import type { createApiClient } from '../api/client';
import { parseOperationResponse, parseOverview, parseQuote, parseStartResponse, type ActivationQuote, type BillingOverview, type Operation, type PlanId } from './billingResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'post'>;

const base = (teamId: string) => `/teams/${encodeURIComponent(teamId)}/billing`;

/** The billing routes (docs/ARCHITECTURE.md 5i). Plain functions over the API client, so they are unit-tested without a screen. */
export function createBillingApi(client: Client) {
  return {
    async overview(teamId: string, signal?: AbortSignal): Promise<BillingOverview> {
      return parseOverview(await client.get<unknown>(base(teamId), { signal }));
    },
    /** The server calculates what the first period costs. Nothing is charged or frozen. */
    async quote(teamId: string, plan: PlanId, seats: number, signal?: AbortSignal): Promise<ActivationQuote> {
      return parseQuote(await client.get<unknown>(`${base(teamId)}/activation-quote?plan=${encodeURIComponent(plan)}&seats=${encodeURIComponent(String(seats))}`, { signal }));
    },
    /**
     * POST: ask the server to start paying for `plan` with `seats`. Only the plan and the seat count are sent: the server decides what it costs.
     * `idempotencyKey` is made once per attempt by the screen: a retry after a timeout sends the SAME key, so the server returns the stored answer
     * instead of starting a second payment.
     */
    async startActivation(teamId: string, input: { plan: PlanId; seats: number }, idempotencyKey: string): Promise<{ operation: Operation; checkoutUrl: string }> {
      return parseStartResponse(await client.post<unknown>(`${base(teamId)}/activation`, input, { headers: { 'Idempotency-Key': idempotencyKey } }));
    },
    /** The server says whether the payment is waiting, being confirmed, paid, failed, expired or under review. The app never decides that. */
    async operation(teamId: string, operationId: string, signal?: AbortSignal): Promise<Operation> {
      return parseOperationResponse(await client.get<unknown>(`${base(teamId)}/operations/${encodeURIComponent(operationId)}`, { signal }));
    },
    async cancel(teamId: string, operationId: string): Promise<Operation> {
      return parseOperationResponse(await client.post<unknown>(`${base(teamId)}/operations/${encodeURIComponent(operationId)}/cancel`));
    },
  };
}
