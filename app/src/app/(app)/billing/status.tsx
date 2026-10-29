import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { BillingHeader } from '../../../billing/BillingHeader';
import { statusCopy } from '../../../billing/billingCopy';
import { describeBillingFailure } from '../../../billing/billingFailure';
import { useCancelOperation, useOperation } from '../../../billing/useBilling';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { InfoCard } from '../../../ui/InfoCard';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';

/**
 * The payment's outcome: waiting, confirming, paid, failed, cancelled, under review. EVERY state comes from the server (AGENTS.md rule 7): this screen asks
 * `GET .../operations/:id` every few seconds until the server says it is settled, and never decides that a payment succeeded. Coming back from Stripe (the
 * deep link) opens this screen and consumes nothing: it only triggers that status check. `from=cancel` means Stripe's "back" link was used; the payment
 * stays open on the server until the person chooses to start again here.
 */
export default function PaymentStatusScreen() {
  return <PaymentStatus />;
}

function PaymentStatus() {
  const params = useLocalSearchParams<{ operation?: string; from?: string }>();
  const operationId = typeof params.operation === 'string' && params.operation.length > 0 ? params.operation : null;
  const cameBackWithoutPaying = params.from === 'cancel';
  const { userId, teamId, teamName } = useScheduleContext();
  const operation = useOperation(userId, teamId, operationId);
  const cancel = useCancelOperation(userId, teamId);
  const [refused, setRefused] = useState<string | null>(null);

  const header = (title: string, subtitle?: string) => <BillingHeader teamName={teamName} title={title} subtitle={subtitle} />;
  const toSchedule = (label: string) => <Button label={label} onPress={() => router.dismissTo('/')} testID="payment-done" />;

  /** Ends an open payment on the server (so a new one can start), then returns to the plan screen. If the server refuses, say why. */
  function startAgain() {
    if (!operationId) {
      router.replace('/billing');
      return;
    }
    cancel.mutate(operationId, {
      onSuccess: () => router.replace('/billing'),
      onError: (error) => {
        const failure = describeBillingFailure(error);
        setRefused(failure?.kind === 'banner' || failure?.kind === 'rate_limited' ? failure.message : 'Couldn’t cancel this payment. Try again.');
      },
    });
  }

  if (!operationId || (operation.isError && describeBillingFailure(operation.error)?.kind === 'gone')) {
    return (
      <Screen gap={space[16]}>
        {header(statusCopy.gone.title, statusCopy.gone.body)}
        <Spacer />
        <Button label="Back to schedule" onPress={() => router.dismissTo('/')} testID="payment-gone-back" />
      </Screen>
    );
  }
  if (operation.data === undefined) {
    if (operation.isError) {
      return (
        <Screen gap={space[16]}>
          {header(statusCopy.loadFailed.title, statusCopy.loadFailed.body)}
          <Spacer />
          <Button label={statusCopy.loadFailed.retry} onPress={() => void operation.refetch()} testID="payment-retry" />
        </Screen>
      );
    }
    return (
      <Screen gap={space[16]}>
        {header(statusCopy.title)}
        <Text variant="caption" tone="muted" testID="payment-loading">
          {statusCopy.loading}
        </Text>
      </Screen>
    );
  }

  const op = operation.data;
  const summary = <InfoCard title={`${op.planName} · ${op.seats} seats`} body={op.amountDisplay} testID="payment-summary" />;
  const refusal = refused ? <StatusBanner tone="warning" title={refused} testID="payment-cancel-refused" /> : null;

  switch (op.status) {
    case 'paid':
      return (
        <Screen gap={space[16]}>
          {header(statusCopy.paid.title, statusCopy.paid.subtitle)}
          {summary}
          <Spacer />
          {toSchedule(statusCopy.paid.done)}
        </Screen>
      );
    case 'confirming':
      return (
        <Screen gap={space[16]}>
          {header(statusCopy.confirming.title, statusCopy.confirming.subtitle)}
          {summary}
          <StatusBanner tone="info" title={statusCopy.confirming.banner.title} body={statusCopy.confirming.banner.body} testID="payment-confirming" />
          <Spacer />
          {toSchedule(statusCopy.confirming.back)}
        </Screen>
      );
    case 'failed':
      return (
        <Screen gap={space[16]}>
          {header(statusCopy.failed.title, statusCopy.failed.subtitle)}
          <StatusBanner tone="error" title={statusCopy.failed.banner.title} body={statusCopy.failed.banner.body} testID="payment-failed" />
          <Spacer />
          <Button label={statusCopy.failed.retry} onPress={() => router.replace('/billing')} testID="payment-try-again" />
          {toSchedule(statusCopy.paid.done)}
        </Screen>
      );
    case 'expired':
      return (
        <Screen gap={space[16]}>
          {header(statusCopy.expired.title, statusCopy.expired.subtitle)}
          <StatusBanner tone="info" title={statusCopy.expired.banner.title} body={statusCopy.expired.banner.body} testID="payment-cancelled" />
          <Spacer />
          <Button label={statusCopy.expired.retry} onPress={() => router.replace('/billing')} testID="payment-try-again" />
          {toSchedule(statusCopy.paid.done)}
        </Screen>
      );
    case 'under_review':
      return (
        <Screen gap={space[16]}>
          {header(statusCopy.review.title, statusCopy.review.subtitle)}
          <StatusBanner tone="warning" title={statusCopy.review.banner.title} body={statusCopy.review.banner.body} testID="payment-review" />
          <Spacer />
          {toSchedule(statusCopy.review.back)}
        </Screen>
      );
    default:
      // awaiting_payment. Coming back from Stripe's "back" link reads as cancelled; the payment is still open on the server until the person starts again.
      if (cameBackWithoutPaying) {
        return (
          <Screen gap={space[16]}>
            {header(statusCopy.expired.title, statusCopy.expired.subtitle)}
            <StatusBanner tone="info" title={statusCopy.expired.banner.title} body={statusCopy.expired.banner.body} testID="payment-cancelled" />
            {refusal}
            <Spacer />
            <Button label={statusCopy.expired.retry} loading={cancel.isPending} onPress={startAgain} testID="payment-start-again" />
            {toSchedule(statusCopy.paid.done)}
          </Screen>
        );
      }
      return (
        <Screen gap={space[16]}>
          {header(statusCopy.waiting.title, statusCopy.waiting.subtitle)}
          {summary}
          <StatusBanner tone="info" title={statusCopy.waiting.banner.title} body={statusCopy.waiting.banner.body} testID="payment-waiting" />
          {refusal}
          <Spacer />
          <Button label={statusCopy.waiting.cancel} variant="secondary" loading={cancel.isPending} onPress={startAgain} testID="payment-cancel" />
        </Screen>
      );
  }
}
