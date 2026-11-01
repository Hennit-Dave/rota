import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { BillingHeader } from '../../../billing/BillingHeader';
import { activateCopy, cardCopy } from '../../../billing/billingCopy';
import { describeBillingFailure } from '../../../billing/billingFailure';
import { useBillingOverview, useRemoveCard, useStartCardSetup } from '../../../billing/useBilling';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { EmptyCard } from '../../../ui/EmptyCard';
import { InfoCard } from '../../../ui/InfoCard';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { useOnline } from '../../../ui/useOnline';

/**
 * The payment method (ADR 0030; layout NOT YET compared with Figma 07 Billing). Shows the saved card and what the Owner agreed to, and starts saving or replacing one.
 * Every word about the agreement, and every date, is the SERVER's finished text: this screen holds no amount, makes none, and never decides that a card was saved.
 * "Continue to Stripe" asks the server to start (one request with an Idempotency-Key made once per visit, so Try again after a timeout sends the same key),
 * then opens Stripe's page and moves to the status screen, which asks the server.
 */
export default function CardScreen() {
  return <Card />;
}

function Card() {
  const online = useOnline();
  const { userId, teamId, teamName, detail } = useScheduleContext();
  const canManage = detail.data?.canManageBilling === true;
  const overview = useBillingOverview(userId, teamId, canManage);
  const start = useStartCardSetup(teamId);
  const remove = useRemoveCard(userId, teamId);
  const [offlineBlocked, setOfflineBlocked] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // One idempotency key per visit: the same choice retried reuses it, so the server returns the stored answer instead of starting a second attempt.
  const key = useRef<string | null>(null);

  const header = <BillingHeader teamName={teamName} title={cardCopy.title} subtitle={cardCopy.subtitle} />;
  const back = <Button label={cardCopy.back} variant="secondary" onPress={() => router.replace('/billing')} testID="card-back" />;

  if (detail.data === undefined || (canManage && overview.data === undefined && !overview.isError)) {
    return (
      <Screen gap={space[16]}>
        {header}
        <Text variant="caption" tone="muted" testID="card-loading">
          {cardCopy.loading}
        </Text>
      </Screen>
    );
  }
  if (!canManage) {
    return (
      <Screen gap={space[16]}>
        {header}
        <EmptyCard title={cardCopy.forbidden} body="" testID="card-forbidden" />
        <Spacer />
        {back}
      </Screen>
    );
  }
  if (overview.isError || overview.data === undefined) {
    return (
      <Screen gap={space[16]}>
        {header}
        <StatusBanner tone={online ? 'error' : 'warning'} title={online ? activateCopy.loadFailed.title : activateCopy.offline} body={activateCopy.loadFailed.body} testID="card-error" />
        <Button label={activateCopy.loadFailed.retry} variant="secondary" onPress={() => void overview.refetch()} testID="card-retry" />
        <Spacer />
        {back}
      </Screen>
    );
  }

  const data = overview.data;
  // The server offers the wording only once the team has a subscription: until then the card is saved on the activation page, while paying.
  if (!data.activated || data.cardConsentWording === null) {
    return (
      <Screen gap={space[16]}>
        {header}
        <StatusBanner tone="info" title={cardCopy.needsPlan} testID="card-needs-plan" />
        <Spacer />
        {back}
      </Screen>
    );
  }

  function save() {
    if (!online) {
      setOfflineBlocked(true);
      return;
    }
    setOfflineBlocked(false);
    key.current ??= Crypto.randomUUID();
    start.mutate(
      { idempotencyKey: key.current },
      {
        onSuccess: async ({ setup, checkoutUrl }) => {
          try {
            await WebBrowser.openBrowserAsync(checkoutUrl);
          } finally {
            // Whatever happened in the browser, the server is asked. The deep link back from Stripe lands on the same screen.
            router.replace({ pathname: '/billing/card-status', params: { setup: setup.id } });
          }
        },
      },
    );
  }

  const failure = offlineBlocked ? ({ kind: 'offline' } as const) : start.isError ? describeBillingFailure(start.error) : null;
  let banner: React.ReactNode = null;
  if (failure?.kind === 'offline') banner = <StatusBanner tone="warning" title={cardCopy.offline} testID="card-offline" />;
  else if (failure?.kind === 'banner' || failure?.kind === 'rate_limited') banner = <StatusBanner tone="warning" title={failure.message} testID="card-failed" />;
  else if (failure?.kind === 'unavailable') banner = <StatusBanner tone="warning" title={cardCopy.unavailable.title} body={cardCopy.unavailable.body} testID="card-failed" />;
  else if (failure?.kind === 'generic') banner = <StatusBanner tone="error" title={cardCopy.failedToStart.title} body={cardCopy.failedToStart.body} reference={failure.reference ?? undefined} testID="card-failed" />;

  const saved = data.savedCard;
  return (
    <Screen gap={space[16]}>
      {header}
      {saved ? (
        <InfoCard title={saved.summary} body={saved.expiresDisplay} testID="card-saved">
          <Text variant="caption" tone="muted">{cardCopy.agreedOn(saved.consentedOn)}</Text>
          <Text variant="caption" tone="muted" testID="card-saved-consent">{saved.consentWording}</Text>
        </InfoCard>
      ) : (
        <EmptyCard title={cardCopy.none.title} body={cardCopy.none.body} testID="card-none" />
      )}
      <InfoCard title={cardCopy.consentTitle} body="" testID="card-consent">
        <Text variant="caption" tone="muted" testID="card-consent-wording">{data.cardConsentWording}</Text>
      </InfoCard>
      {banner}
      <Spacer />
      <Button label={saved ? cardCopy.replace : cardCopy.add} loading={start.isPending} loadingLabel={cardCopy.opening} onPress={save} testID="card-continue" />
      {saved ? (
        confirmRemove ? (
          <>
            <StatusBanner tone="warning" title={cardCopy.removeConfirm.title} body={cardCopy.removeConfirm.body} testID="card-remove-confirm" />
            {remove.isError ? <StatusBanner tone="error" title={cardCopy.removeFailed} testID="card-remove-failed" /> : null}
            <Button
              label={cardCopy.removeConfirm.yes}
              variant="outline"
              loading={remove.isPending}
              loadingLabel={cardCopy.removing}
              onPress={() => remove.mutate(undefined, { onSuccess: () => setConfirmRemove(false) })}
              testID="card-remove-yes"
            />
            <Button label={cardCopy.removeConfirm.no} variant="secondary" onPress={() => setConfirmRemove(false)} testID="card-remove-no" />
          </>
        ) : (
          <Button label={cardCopy.remove} variant="outline" onPress={() => setConfirmRemove(true)} testID="card-remove" />
        )
      ) : null}
      {back}
    </Screen>
  );
}
