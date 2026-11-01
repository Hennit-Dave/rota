import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { BillingHeader } from '../../../billing/BillingHeader';
import { cardStatusCopy as copy } from '../../../billing/billingCopy';
import { describeBillingFailure } from '../../../billing/billingFailure';
import { useCancelCardSetup, useCardSetup } from '../../../billing/useBilling';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';

/**
 * The outcome of saving a card: waiting, confirming, saved, failed, cancelled, under review. EVERY state comes from the server (AGENTS.md rule 7): this screen asks
 * `GET .../card/setups/:id` every few seconds until the server says it is settled, and never decides that a card was saved. Coming back from Stripe (the deep link)
 * opens this screen and consumes nothing. `from=cancel` means Stripe's "back" link was used; the attempt stays open on the server until the person chooses to try again.
 */
export default function CardStatusScreen() {
  return <CardStatus />;
}

function CardStatus() {
  const params = useLocalSearchParams<{ setup?: string; from?: string }>();
  const setupId = typeof params.setup === 'string' && params.setup.length > 0 ? params.setup : null;
  const cameBackWithoutSaving = params.from === 'cancel';
  const { userId, teamId, teamName } = useScheduleContext();
  const setup = useCardSetup(userId, teamId, setupId);
  const cancel = useCancelCardSetup(userId, teamId);
  const [refused, setRefused] = useState<string | null>(null);

  const header = (title: string, subtitle?: string) => <BillingHeader teamName={teamName} title={title} subtitle={subtitle} />;
  const toBilling = (label: string) => <Button label={label} onPress={() => router.replace('/billing')} testID="card-status-done" />;

  /** Ends an open attempt on the server (so a new one can start), then returns to the card screen. If the server refuses, say why. */
  function startAgain() {
    if (!setupId) {
      router.replace('/billing/card');
      return;
    }
    cancel.mutate(setupId, {
      onSuccess: () => router.replace('/billing/card'),
      onError: (error) => {
        const failure = describeBillingFailure(error);
        setRefused(failure?.kind === 'banner' || failure?.kind === 'rate_limited' ? failure.message : 'Couldn’t cancel this. Try again.');
      },
    });
  }

  if (!setupId || (setup.isError && describeBillingFailure(setup.error)?.kind === 'gone')) {
    return (
      <Screen gap={space[16]}>
        {header(copy.gone.title, copy.gone.body)}
        <Spacer />
        {toBilling('Back to billing')}
      </Screen>
    );
  }
  if (setup.data === undefined) {
    if (setup.isError) {
      return (
        <Screen gap={space[16]}>
          {header(copy.loadFailed.title, copy.loadFailed.body)}
          <Spacer />
          <Button label={copy.loadFailed.retry} onPress={() => void setup.refetch()} testID="card-status-retry" />
        </Screen>
      );
    }
    return (
      <Screen gap={space[16]}>
        {header(copy.title)}
        <Text variant="caption" tone="muted" testID="card-status-loading">
          {copy.loading}
        </Text>
      </Screen>
    );
  }

  const refusal = refused ? <StatusBanner tone="warning" title={refused} testID="card-cancel-refused" /> : null;
  switch (setup.data.status) {
    case 'saved':
      return (
        <Screen gap={space[16]}>
          {header(copy.saved.title, copy.saved.subtitle)}
          <Spacer />
          {toBilling(copy.saved.done)}
        </Screen>
      );
    case 'confirming':
      return (
        <Screen gap={space[16]}>
          {header(copy.confirming.title, copy.confirming.subtitle)}
          <StatusBanner tone="info" title={copy.confirming.banner.title} body={copy.confirming.banner.body} testID="card-status-confirming" />
          <Spacer />
          {toBilling(copy.confirming.back)}
        </Screen>
      );
    case 'failed':
      return (
        <Screen gap={space[16]}>
          {header(copy.failed.title, copy.failed.subtitle)}
          <StatusBanner tone="error" title={copy.failed.banner.title} body={copy.failed.banner.body} testID="card-status-failed" />
          <Spacer />
          <Button label={copy.failed.retry} onPress={() => router.replace('/billing/card')} testID="card-status-try-again" />
          {toBilling('Back to billing')}
        </Screen>
      );
    case 'expired':
      return (
        <Screen gap={space[16]}>
          {header(copy.expired.title, copy.expired.subtitle)}
          <StatusBanner tone="info" title={copy.expired.banner.title} body={copy.expired.banner.body} testID="card-status-cancelled" />
          <Spacer />
          <Button label={copy.expired.retry} onPress={() => router.replace('/billing/card')} testID="card-status-try-again" />
          {toBilling('Back to billing')}
        </Screen>
      );
    case 'under_review':
      return (
        <Screen gap={space[16]}>
          {header(copy.review.title, copy.review.subtitle)}
          <StatusBanner tone="warning" title={copy.review.banner.title} body={copy.review.banner.body} testID="card-status-review" />
          <Spacer />
          {toBilling(copy.review.back)}
        </Screen>
      );
    default:
      // awaiting_card. Coming back from Stripe's "back" link reads as cancelled; the attempt is still open on the server until the person starts again.
      if (cameBackWithoutSaving) {
        return (
          <Screen gap={space[16]}>
            {header(copy.expired.title, copy.expired.subtitle)}
            <StatusBanner tone="info" title={copy.expired.banner.title} body={copy.expired.banner.body} testID="card-status-cancelled" />
            {refusal}
            <Spacer />
            <Button label={copy.expired.retry} loading={cancel.isPending} onPress={startAgain} testID="card-status-start-again" />
            {toBilling('Back to billing')}
          </Screen>
        );
      }
      return (
        <Screen gap={space[16]}>
          {header(copy.waiting.title, copy.waiting.subtitle)}
          <StatusBanner tone="info" title={copy.waiting.banner.title} body={copy.waiting.banner.body} testID="card-status-waiting" />
          {refusal}
          <Spacer />
          <Button label={copy.waiting.cancel} variant="secondary" loading={cancel.isPending} onPress={startAgain} testID="card-status-cancel" />
        </Screen>
      );
  }
}
