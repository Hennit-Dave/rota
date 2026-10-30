import type { createApiClient } from '../api/client';
import {
  parseChangeAnswer,
  parseChangeQuote,
  parseHistory,
  parseOperationResponse,
  parseOverview,
  parseScheduleAnswer,
  parseQuote,
  parseStartResponse,
  type ActivationQuote,
  type BillingOverview,
  type ChangeAnswer,
  type ChangeQuote,
  type HistoryEntry,
  type Operation,
  type PlanId,
  type ScheduledChange,
} from './billingResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'post' | 'request'>;

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
    /** What a change to this plan and seat count would cost and when it starts. The server calculates it; nothing is charged or frozen. */
    async changeQuote(teamId: string, plan: PlanId, seats: number, signal?: AbortSignal): Promise<ChangeQuote> {
      return parseChangeQuote(await client.get<unknown>(`${base(teamId)}/change-quote?plan=${encodeURIComponent(plan)}&seats=${encodeURIComponent(String(seats))}`, { signal }));
    },
    /** POST: make the change. Only the plan and the seat count are sent. A repeat with the same `idempotencyKey` returns the stored answer instead of acting twice. */
    async startChange(teamId: string, input: { plan: PlanId; seats: number }, idempotencyKey: string): Promise<ChangeAnswer> {
      return parseChangeAnswer(await client.post<unknown>(`${base(teamId)}/changes`, input, { headers: { 'Idempotency-Key': idempotencyKey } }));
    },
    /** Charges, credits, refunds and plan or seat changes, newest first, as the ledger holds them. */
    async history(teamId: string, signal?: AbortSignal): Promise<{ history: HistoryEntry[]; hasMore: boolean }> {
      return parseHistory(await client.get<unknown>(`${base(teamId)}/history`, { signal }));
    },
    /**
     * POST: schedule a decrease for the end of the period. Only the plan, the seat count, the chosen people and whether the Owner accepts the fallback are sent;
     * the server checks who may be chosen and decides the date. A repeat with the same `idempotencyKey` returns the stored answer.
     */
    async scheduleReduction(
      teamId: string,
      input: { plan: PlanId; seats: number; selectedMemberIds: string[]; acceptFallback: boolean },
      idempotencyKey: string,
    ): Promise<ScheduledChange> {
      return parseScheduleAnswer(await client.post<unknown>(`${base(teamId)}/reductions`, input, { headers: { 'Idempotency-Key': idempotencyKey } }));
    },
    /** DELETE …/reductions/current: take back the scheduled reduction (204, no body). The server says whether it can still be taken back. */
    async cancelReduction(teamId: string): Promise<void> {
      await client.request(`${base(teamId)}/reductions/current`, { method: 'DELETE' });
    },
    async cancel(teamId: string, operationId: string): Promise<Operation> {
      return parseOperationResponse(await client.post<unknown>(`${base(teamId)}/operations/${encodeURIComponent(operationId)}/cancel`));
    },
  };
}
