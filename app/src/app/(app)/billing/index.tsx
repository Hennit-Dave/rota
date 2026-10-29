import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { BillingHeader } from '../../../billing/BillingHeader';
import { activateCopy } from '../../../billing/billingCopy';
import { describeBillingFailure } from '../../../billing/billingFailure';
import { PLAN_IDS, type PlanId } from '../../../billing/billingResponses';
import { useActivationQuote, useBillingOverview, useStartActivation } from '../../../billing/useBilling';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { EmptyCard } from '../../../ui/EmptyCard';
import { InfoCard } from '../../../ui/InfoCard';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { TextField } from '../../../ui/TextField';
import { useOnline } from '../../../ui/useOnline';

/**
 * Activate subscription (layout NOT YET compared with Figma 07 Billing, node 9:2). Pick a plan and a number of seats; the SERVER says what the first period costs and the app shows it.
 * "Continue to payment" asks the server to start the payment (one request, with an Idempotency-Key made once per plan-and-seats choice, so Try again after a
 * timeout sends the same key and the server returns the stored answer), then opens Stripe's page in the browser. The app never calculates, compares or stores
 * an amount, and it never decides that anything was paid: it moves to the status screen, which asks the server (AGENTS.md rules 2 and 7).
 */
export default function BillingScreen() {
  return <Billing />;
}

/** The digits typed in the seats field as a whole number of seats, or null when it is not one. Not an amount. */
function seatsFrom(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

function Billing() {
  const online = useOnline();
  const { userId, teamId, teamName, detail } = useScheduleContext();
  const canManage = detail.data?.canManageBilling === true;
  const overview = useBillingOverview(userId, teamId, canManage);

  const [plan, setPlan] = useState<PlanId>('starter');
  const [seatsText, setSeatsText] = useState('5');
  const [debouncedSeats, setDebouncedSeats] = useState<number | null>(5);
  const [offlineBlocked, setOfflineBlocked] = useState(false);
  // The seat count the quote is asked for follows the field a moment after typing stops (a UI timing, not a business number).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSeats(seatsFrom(seatsText)), 500);
    return () => clearTimeout(t);
  }, [seatsText]);

  const quote = useActivationQuote(userId, canManage && overview.data?.activated === false ? teamId : null, plan, debouncedSeats);
  const start = useStartActivation(teamId);

  // One idempotency key per (plan, seats) choice: the same choice retried reuses it, a different choice gets a new one.
  const attempt = useRef<{ key: string; plan: PlanId; seats: number } | null>(null);
  function keyFor(p: PlanId, seats: number): string {
    if (!attempt.current || attempt.current.plan !== p || attempt.current.seats !== seats) attempt.current = { key: Crypto.randomUUID(), plan: p, seats };
    return attempt.current.key;
  }

  const seats = seatsFrom(seatsText);
  const seatsSettled = seats !== null && seats === debouncedSeats;
  const quoteReady = quote.data !== undefined && seatsSettled && quote.data.plan === plan && quote.data.seats === seats;

  function pay() {
    if (seats === null || !quoteReady) return;
    if (!online) {
      setOfflineBlocked(true);
      return;
    }
    setOfflineBlocked(false);
    start.mutate(
      { plan, seats, idempotencyKey: keyFor(plan, seats) },
      {
        onSuccess: async ({ operation, checkoutUrl }) => {
          try {
            await WebBrowser.openBrowserAsync(checkoutUrl);
          } finally {
            // Whatever happened in the browser, the server is asked. The deep link back from Stripe lands on the same screen.
            router.replace({ pathname: '/billing/status', params: { operation: operation.id } });
          }
        },
      },
    );
  }

  const header = <BillingHeader teamName={teamName} title={activateCopy.title} subtitle={activateCopy.subtitle} />;
  const back = <Button label={activateCopy.back} variant="secondary" onPress={() => router.dismissTo('/')} testID="billing-back" />;

  if (detail.data === undefined || (canManage && overview.data === undefined && !overview.isError)) {
    return (
      <Screen gap={space[16]}>
        {header}
        <Text variant="caption" tone="muted" testID="billing-loading">
          {activateCopy.loading}
        </Text>
      </Screen>
    );
  }
  if (!canManage) {
    return (
      <Screen gap={space[16]}>
        {header}
        <EmptyCard title={activateCopy.forbidden} body="" testID="billing-forbidden" />
        <Spacer />
        {back}
      </Screen>
    );
  }
  if (overview.isError || overview.data === undefined) {
    return (
      <Screen gap={space[16]}>
        {header}
        <StatusBanner tone={online ? 'error' : 'warning'} title={online ? activateCopy.loadFailed.title : activateCopy.offline} body={activateCopy.loadFailed.body} testID="billing-error" />
        <Button label={activateCopy.loadFailed.retry} variant="secondary" onPress={() => void overview.refetch()} testID="billing-retry" />
        <Spacer />
        {back}
      </Screen>
    );
  }

  const data = overview.data;
  if (data.activated && data.subscription) {
    return (
      <Screen gap={space[16]}>
        <BillingHeader teamName={teamName} title={activateCopy.yourPlan} subtitle={data.testModeNotice} />
        <InfoCard title={activateCopy.planSummary(data.subscription.planName, data.subscription.seats)} body={data.subscription.monthlyDisplay} testID="billing-plan" />
        <Text variant="caption" tone="muted">
          {activateCopy.currentPeriod(data.subscription.periodStartsOn, data.subscription.periodEndsOn)}
        </Text>
        <Spacer />
        {back}
      </Screen>
    );
  }

  const failure = offlineBlocked ? ({ kind: 'offline' } as const) : start.isError ? describeBillingFailure(start.error) : null;
  let banner: React.ReactNode = null;
  if (failure?.kind === 'offline') banner = <StatusBanner tone="warning" title={activateCopy.offline} testID="billing-offline" />;
  else if (failure?.kind === 'banner' || failure?.kind === 'rate_limited') banner = <StatusBanner tone="warning" title={failure.message} testID="billing-failed" />;
  else if (failure?.kind === 'unavailable') banner = <StatusBanner tone="warning" title="The payment service didn’t answer" body="Nothing was charged. Try again." testID="billing-failed" />;
  else if (failure?.kind === 'generic') banner = <StatusBanner tone="error" title="Couldn’t start the payment" body="Please try again." reference={failure.reference ?? undefined} testID="billing-failed" />;

  const chosen = data.plans.find((p) => p.id === plan);
  return (
    <Screen gap={space[16]}>
      {header}
      <Text variant="label">{activateCopy.planLabel}</Text>
      <View style={{ gap: space[8] }}>
        {PLAN_IDS.map((id) => {
          const option = data.plans.find((p) => p.id === id);
          if (!option) return null;
          return <Button key={id} label={`${option.name} · ${option.priceDisplay} / month`} variant={id === plan ? 'primary' : 'outline'} onPress={() => setPlan(id)} testID={`billing-plan-${id}`} />;
        })}
      </View>
      {chosen ? (
        <Text variant="caption" tone="muted" testID="billing-plan-terms">
          {activateCopy.included(chosen.includedSeats)} · {chosen.extraSeatDisplay ? activateCopy.extraSeat(chosen.extraSeatDisplay) : activateCopy.noExtraSeats}
        </Text>
      ) : null}
      <TextField
        label={activateCopy.seatsLabel}
        helper={activateCopy.seatsHelper}
        error={seats === null ? activateCopy.seatsInvalid : undefined}
        value={seatsText}
        onChangeText={(t) => setSeatsText(t.replace(/[^0-9]/g, '').slice(0, 5))}
        keyboardType="number-pad"
        testID="billing-seats"
      />
      {quoteReady && quote.data ? (
        <InfoCard title={activateCopy.priceTitle} body={quote.data.chargeTodayDisplay} testID="billing-quote">
          <Text variant="caption" tone="muted">{quote.data.note}</Text>
          <Text variant="caption" tone="muted">{`${quote.data.periodStartsOn} to ${quote.data.periodEndsOn}`}</Text>
          <Text variant="caption" tone="muted">{quote.data.testModeNotice}</Text>
        </InfoCard>
      ) : quote.isError && seatsSettled ? (
        <StatusBanner tone="warning" title={describeQuoteProblem(quote.error)} testID="billing-quote-error" />
      ) : seats !== null ? (
        <Text variant="caption" tone="muted" testID="billing-quote-loading">
          {activateCopy.loadingQuote}
        </Text>
      ) : null}
      {banner}
      <Spacer />
      <Button label={activateCopy.continue} loading={start.isPending} loadingLabel={activateCopy.opening} disabled={!quoteReady} onPress={pay} testID="billing-continue" />
      {back}
    </Screen>
  );
}

function describeQuoteProblem(error: unknown): string {
  const f = describeBillingFailure(error);
  if (f?.kind === 'banner' || f?.kind === 'rate_limited') return f.message;
  if (f?.kind === 'offline') return activateCopy.offline;
  return 'Couldn’t work out the price. Try again.';
}
