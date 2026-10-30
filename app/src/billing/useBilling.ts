import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBillingApi } from '../services';
import { useEffect } from 'react';
import { billingKey, historyKey, isSettled, operationKey, type PlanId } from './billingResponses';
import { operationQueryOptions, refreshAfterSettled } from './operationQuery';

/** The Owner's billing overview. Only asked when the server said this person may manage billing. Never persisted: a subscription is not cached (money.md). */
export function useBillingOverview(userId: string | undefined, teamId: string | null, enabled = true) {
  return useQuery({
    queryKey: billingKey(userId ?? '', teamId ?? ''),
    enabled: enabled && userId !== undefined && teamId !== null,
    networkMode: 'always',
    queryFn: ({ signal }) => getBillingApi().overview(teamId as string, signal),
  });
}

/** What the first period costs, calculated by the server for this plan and seat count. */
export function useActivationQuote(userId: string | undefined, teamId: string | null, plan: PlanId, seats: number | null) {
  return useQuery({
    queryKey: [...billingKey(userId ?? '', teamId ?? ''), 'quote', plan, seats] as const,
    enabled: userId !== undefined && teamId !== null && seats !== null,
    networkMode: 'always',
    retry: false,
    queryFn: ({ signal }) => getBillingApi().quote(teamId as string, plan, seats as number, signal),
  });
}

/** Starts the payment: one request the person watches. Never queued offline and never retried by the library (a retry sends the same idempotency key by hand). */
export function useStartActivation(teamId: string | null) {
  return useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: (v: { plan: PlanId; seats: number; idempotencyKey: string }) =>
      getBillingApi().startActivation(teamId as string, { plan: v.plan, seats: v.seats }, v.idempotencyKey),
  });
}

/** One payment operation, asked again every few seconds until the SERVER says it is settled. The app never decides that a payment succeeded. */
export function useOperation(userId: string | undefined, teamId: string | null, operationId: string | null) {
  const client = useQueryClient();
  const query = useQuery(operationQueryOptions(client, { api: getBillingApi, userId, teamId, operationId }));
  // Once, when the server says the payment is settled: ask for the overview and the team detail again.
  const settled = query.data !== undefined && isSettled(query.data.status);
  useEffect(() => {
    if (settled && userId !== undefined && teamId !== null) refreshAfterSettled(client, userId, teamId);
  }, [settled, client, userId, teamId]);
  return query;
}

/** The buyer backs out: the server ends an open payment so they can start again. */
export function useCancelOperation(userId: string | undefined, teamId: string | null) {
  const client = useQueryClient();
  return useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: (operationId: string) => getBillingApi().cancel(teamId as string, operationId),
    onSettled: (_data, _error, operationId) => {
      if (userId === undefined || teamId === null) return;
      void client.invalidateQueries({ queryKey: operationKey(userId, teamId, operationId) });
    },
  });
}

/** What a change would cost, calculated by the server for this plan and seat count. */
export function useChangeQuote(userId: string | undefined, teamId: string | null, plan: PlanId, seats: number | null) {
  return useQuery({
    queryKey: [...billingKey(userId ?? '', teamId ?? ''), 'change-quote', plan, seats] as const,
    enabled: userId !== undefined && teamId !== null && seats !== null,
    networkMode: 'always',
    retry: false,
    queryFn: ({ signal }) => getBillingApi().changeQuote(teamId as string, plan, seats as number, signal),
  });
}

/** Makes the change: one request the person watches. Never queued offline, never retried by the library (a retry sends the same idempotency key by hand). */
export function useStartChange(teamId: string | null) {
  return useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: (v: { plan: PlanId; seats: number; idempotencyKey: string }) =>
      getBillingApi().startChange(teamId as string, { plan: v.plan, seats: v.seats }, v.idempotencyKey),
  });
}

/** The team's money history. Never persisted: it is read from the ledger every time it is asked for. */
export function useBillingHistory(userId: string | undefined, teamId: string | null, enabled = true) {
  return useQuery({
    queryKey: historyKey(userId ?? '', teamId ?? ''),
    enabled: enabled && userId !== undefined && teamId !== null,
    networkMode: 'always',
    queryFn: ({ signal }) => getBillingApi().history(teamId as string, signal),
  });
}
