import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { BillingHeader } from '../../../billing/BillingHeader';
import { changeCopy, reductionCopy } from '../../../billing/billingCopy';
import { ReductionPicker } from '../../../billing/ReductionPicker';
import { describeBillingFailure } from '../../../billing/billingFailure';
import { PLAN_IDS, type ChangeAnswer, type PlanId } from '../../../billing/billingResponses';
import { refreshAfterSettled } from '../../../billing/operationQuery';
import { seatsFrom } from '../../../billing/seatsInput';
import { useBillingOverview, useChangeQuote, useScheduleReduction, useStartChange } from '../../../billing/useBilling';
import { useMembers } from '../../../teams/useTeamData';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { InfoCard } from '../../../ui/InfoCard';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { TextField } from '../../../ui/TextField';
import { useOnline } from '../../../ui/useOnline';

/**
 * Change plan or seats (ADR 0028). Pick a plan and a number of seats; the SERVER says what it costs, when it starts, and whether it can be made. A change
 * that costs nothing is applied at once; a paid one opens Stripe's page and then the payment status screen, which asks the server (AGENTS.md rules 2 and 7).
 * The Idempotency-Key is made once per plan-and-seats choice, so Try again after a timeout sends the same key and the server returns the stored answer.
 * The app does no arithmetic on money and compares no amount: every figure and sentence below is the server's text.
 */
export default function ChangeScreen() {
  return <Change />;
}

function Change() {
  const online = useOnline();
  const client = useQueryClient();
  const { userId, teamId, teamName, detail } = useScheduleContext();
  const canManage = detail.data?.canManageBilling === true;
  const overview = useBillingOverview(userId, teamId, canManage);
  const sub = overview.data?.subscription ?? null;

  const [plan, setPlan] = useState<PlanId | null>(null);
  const [seatsText, setSeatsText] = useState<string | null>(null);
  const [debouncedSeats, setDebouncedSeats] = useState<number | null>(null);
  const [applied, setApplied] = useState<Extract<ChangeAnswer, { status: 'applied' }> | null>(null);
  const [offlineBlocked, setOfflineBlocked] = useState(false);
  // A reduction: who becomes inactive and whether the fallback is accepted. Cleared whenever the plan or the seats change (they would no longer match the quote).
  const [picked, setPicked] = useState<{ for: string; ids: string[]; fallback: boolean }>({ for: '', ids: [], fallback: false });
  const [scheduled, setScheduled] = useState<string | null>(null);

  // Start from what the team has now.
  const chosenPlan: PlanId | null = plan ?? sub?.plan ?? null;
  const chosenText = seatsText ?? (sub ? String(sub.seats) : '');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSeats(seatsFrom(chosenText)), 500);
    return () => clearTimeout(t);
  }, [chosenText]);

  const seats = seatsFrom(chosenText);
  const quote = useChangeQuote(userId, sub && chosenPlan ? teamId : null, chosenPlan ?? 'starter', debouncedSeats);
  const start = useStartChange(teamId);
  const schedule = useScheduleReduction(userId, teamId);
  const members = useMembers(userId, teamId);

  const attempt = useRef<{ key: string; sig: string } | null>(null);
  // One key per choice (plan, seats, and for a reduction the people and the fallback): a retry of the same choice sends the same key.
  function keyFor(p: PlanId, n: number, ids: string[] = [], fallback = false): string {
    const sig = `${p}|${n}|${[...ids].sort().join(',')}|${fallback ? 1 : 0}`;
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { key: Crypto.randomUUID(), sig };
    return attempt.current.key;
  }

  const quoteReady = quote.data !== undefined && seats !== null && seats === debouncedSeats && quote.data.applyNow.plan !== undefined && chosenPlan !== null;
  const q = quoteReady ? quote.data : undefined;
  const reduction = q?.reduction ?? null;
  const pickKey = `${chosenPlan}|${seats}`;
  const choice = picked.for === pickKey ? picked : { for: pickKey, ids: [] as string[], fallback: false };
  const canSubmit = q !== undefined && q.supported && (reduction === null || choice.ids.length === reduction.membersToDeactivate);

  function submit() {
    if (!canSubmit || !chosenPlan || seats === null || !q) return;
    if (!online) {
      setOfflineBlocked(true);
      return;
    }
    setOfflineBlocked(false);
    if (reduction) {
      schedule.mutate(
        { plan: chosenPlan, seats, selectedMemberIds: choice.ids, acceptFallback: choice.fallback, idempotencyKey: keyFor(chosenPlan, seats, choice.ids, choice.fallback) },
        { onSuccess: (change) => setScheduled(change.message) },
      );
      return;
    }
    start.mutate(
      { plan: chosenPlan, seats, idempotencyKey: keyFor(chosenPlan, seats) },
      {
        onSuccess: async (answer) => {
          if (userId !== undefined && teamId !== null) refreshAfterSettled(client, userId, teamId);
          if (answer.status === 'applied') {
            setApplied(answer);
            return;
          }
          try {
            await WebBrowser.openBrowserAsync(answer.checkoutUrl);
          } finally {
            // Whatever happened in the browser, the server is asked. The deep link back from Stripe lands on the same screen.
            router.replace({ pathname: '/billing/status', params: { operation: answer.operation.id } });
          }
        },
      },
    );
  }

  const header = <BillingHeader teamName={teamName} title={changeCopy.title} subtitle={changeCopy.subtitle} />;
  const back = <Button label={changeCopy.back} variant="secondary" onPress={() => router.back()} testID="change-back" />;

  if (applied) {
    return (
      <Screen gap={space[16]}>
        <BillingHeader teamName={teamName} title={changeCopy.appliedTitle} subtitle={changeCopy.appliedSubtitle} />
        <InfoCard title={`${applied.change.planName} · ${applied.change.seats} seats`} body={applied.change.message} testID="change-applied">
          <Text variant="caption" tone="muted">{`${changeCopy.renewalTitle}: ${applied.change.nextRenewalDisplay}`}</Text>
        </InfoCard>
        <Spacer />
        <Button label={changeCopy.backToBilling} onPress={() => router.replace('/billing')} testID="change-done" />
      </Screen>
    );
  }
  if (scheduled !== null) {
    return (
      <Screen gap={space[16]}>
        <BillingHeader teamName={teamName} title={reductionCopy.scheduledTitle} subtitle={reductionCopy.scheduledSubtitle} />
        <InfoCard title={reductionCopy.scheduleTitle} body={scheduled} testID="reduce-scheduled" />
        <Spacer />
        <Button label={changeCopy.backToBilling} onPress={() => router.replace('/billing')} testID="reduce-done" />
      </Screen>
    );
  }
  if (!sub || !chosenPlan) {
    return (
      <Screen gap={space[16]}>
        {header}
        <Text variant="caption" tone="muted" testID="change-loading">…</Text>
        <Spacer />
        {back}
      </Screen>
    );
  }

  const failure = offlineBlocked ? ({ kind: 'offline' } as const) : schedule.isError && reduction ? describeBillingFailure(schedule.error) : start.isError ? describeBillingFailure(start.error) : null;
  let banner: React.ReactNode = null;
  if (failure?.kind === 'offline') banner = <StatusBanner tone="warning" title={changeCopy.offline} testID="change-offline" />;
  else if (failure?.kind === 'banner' || failure?.kind === 'rate_limited') banner = <StatusBanner tone="warning" title={failure.message} testID="change-failed" />;
  else if (failure?.kind === 'unavailable') banner = <StatusBanner tone="warning" title="The payment service didn’t answer" body="Nothing was charged. Try again." testID="change-failed" />;
  else if (failure?.kind === 'generic') banner = <StatusBanner tone="error" title="Couldn’t make the change" body="Please try again." reference={failure.reference ?? undefined} testID="change-failed" />;

  const submitLabel = reduction ? reductionCopy.schedule : q?.effect === 'now' ? changeCopy.applyNow : changeCopy.continueToPayment;
  return (
    <Screen gap={space[16]}>
      {header}
      <InfoCard title={changeCopy.current} body={`${sub.planName} · ${sub.seats} seats · ${sub.monthlyDisplay}`} testID="change-current" />
      <Text variant="label">{changeCopy.planLabel}</Text>
      <View style={{ gap: space[8] }}>
        {PLAN_IDS.map((id) => {
          const option = overview.data?.plans.find((p) => p.id === id);
          if (!option) return null;
          return <Button key={id} label={`${option.name} · ${option.priceDisplay} / month`} variant={id === chosenPlan ? 'primary' : 'outline'} onPress={() => setPlan(id)} testID={`change-plan-${id}`} />;
        })}
      </View>
      <TextField
        label={changeCopy.seatsLabel}
        error={seats === null ? changeCopy.seatsInvalid : undefined}
        value={chosenText}
        onChangeText={(t) => setSeatsText(t.replace(/[^0-9]/g, '').slice(0, 5))}
        keyboardType="number-pad"
        testID="change-seats"
      />
      {q ? (
        <InfoCard title={quoteTitle(q.effect, q.chargeTodayDisplay)} body={q.chargeTodayDisplay ?? undefined} testID="change-quote">
          <Text variant="body">{q.headline}</Text>
          <Text variant="caption" tone="muted">{`${changeCopy.renewalTitle}: ${q.nextRenewalDisplay}`}</Text>
          <Text variant="caption" tone="muted">{`${changeCopy.daysLeft(q.remainingDays)}. ${changeCopy.periodEnds(q.periodEndsOn)}`}</Text>
          <Text variant="caption" tone="muted">{q.testModeNotice}</Text>
        </InfoCard>
      ) : quote.isError && seats !== null && seats === debouncedSeats ? (
        <StatusBanner tone="warning" title={describeQuoteProblem(quote.error)} testID="change-quote-error" />
      ) : seats !== null ? (
        <Text variant="caption" tone="muted" testID="change-quote-loading">{changeCopy.loadingQuote}</Text>
      ) : null}
      {reduction ? (
        members.data ? (
          <ReductionPicker
            reduction={reduction}
            members={members.data}
            selected={choice.ids}
            onToggle={(id) => setPicked({ for: pickKey, ids: choice.ids.includes(id) ? choice.ids.filter((x) => x !== id) : [...choice.ids, id], fallback: choice.fallback })}
            acceptFallback={choice.fallback}
            onToggleFallback={() => setPicked({ for: pickKey, ids: choice.ids, fallback: !choice.fallback })}
          />
        ) : (
          <Text variant="caption" tone="muted" testID="reduce-members-loading">{members.isError ? reductionCopy.membersFailed : reductionCopy.loadingMembers}</Text>
        )
      ) : null}
      {banner}
      <Spacer />
      <Button label={submitLabel} loading={start.isPending || schedule.isPending} loadingLabel={reduction ? reductionCopy.scheduling : q?.effect === 'now' ? changeCopy.applying : changeCopy.opening} disabled={!canSubmit} onPress={submit} testID="change-submit" />
      {back}
    </Screen>
  );
}

/** The title over the server's sentence: what is charged, or why nothing is. Chosen from the server's `effect`; no amount is read or compared. */
function quoteTitle(effect: string, chargeTodayDisplay: string | null): string {
  if (chargeTodayDisplay) return changeCopy.chargeTitle;
  if (effect === 'now') return changeCopy.noCharge;
  if (effect === 'none') return changeCopy.noChange;
  if (effect === 'at_period_end') return reductionCopy.scheduleTitle;
  return changeCopy.notAvailable;
}

function describeQuoteProblem(error: unknown): string {
  const f = describeBillingFailure(error);
  if (f?.kind === 'banner' || f?.kind === 'rate_limited') return f.message;
  if (f?.kind === 'offline') return changeCopy.offline;
  return 'Couldn’t work out the price. Try again.';
}
