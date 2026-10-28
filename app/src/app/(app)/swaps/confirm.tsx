import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { useMe } from '../../../auth/useMe';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { useShift } from '../../../shifts/useShifts';
import { SwapCard } from '../../../swaps/SwapCard';
import { swapConfirmCopy, swapFailedCopy, swapSentCopy } from '../../../swaps/swapCopy';
import { describeSwapFailure } from '../../../swaps/swapFailure';
import { maySendSwap, optimisticSwap } from '../../../swaps/swapOptimistic';
import { shiftWhen } from '../../../swaps/swapText';
import { useCreateSwap } from '../../../swaps/useSwaps';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { InfoCard } from '../../../ui/InfoCard';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { useOnline } from '../../../ui/useOnline';

/**
 * Does this look right? (Figma swap-confirm 8:333) and what follows "Send swap request": the request sent and not yet confirmed (103:342), confirmed
 * (8:350), and "Request wasn't sent" (8:407, offline 103:363). The request is an optimistic update with rollback (app-state.md): "Request sent" shows at
 * once with the control off, the server's answer replaces the guess, and a failure puts everything back. The idempotency key is made ONCE when this screen
 * opens, so "Try again" after a timeout sends the same key and the server returns the stored swap instead of creating a second.
 */
export default function ConfirmSwapScreen() {
  return <ConfirmSwap />;
}

function ConfirmSwap() {
  const online = useOnline();
  const { offeredId, requestedId } = useLocalSearchParams<{ offeredId: string; requestedId: string }>();
  const me = useMe();
  const { userId, teamId, teamName, timeZone } = useScheduleContext();
  const offered = useShift(userId, teamId, offeredId);
  const requested = useShift(userId, teamId, requestedId);
  const create = useCreateSwap(userId, teamId);
  const key = useRef(Crypto.randomUUID()).current;
  const [offlineBlocked, setOfflineBlocked] = useState(false);
  const zone = timeZone ?? 'UTC';

  const ready = offered.data && requested.data && me.data && timeZone;
  const guess =
    ready && offered.data && requested.data && me.data
      ? optimisticSwap({ key, me: { id: me.data.id, name: me.data.name }, offered: offered.data, requested: requested.data, now: new Date(0) })
      : null;

  function send() {
    if (!offered.data || !requested.data || !me.data) return;
    // Checked BEFORE `mutate` (app-state.md): offline nothing is sent, nothing is queued, and nothing is resumed later.
    const may = maySendSwap({ online, sending: create.isPending });
    if (may === 'busy') return;
    if (may === 'offline') {
      setOfflineBlocked(true);
      return;
    }
    setOfflineBlocked(false);
    create.mutate({ offered: offered.data, requested: requested.data, key, me: { id: me.data.id, name: me.data.name } });
  }

  if (!ready || !guess) {
    return (
      <Screen gap={space[16]}>
        <PageHeader eyebrowGap={16} teamName={teamName} title={swapConfirmCopy.title} subtitle={swapConfirmCopy.subtitle} />
        <Text variant="caption" tone="muted">
          …
        </Text>
        <Spacer />
        <Button label={swapConfirmCopy.back} variant="secondary" onPress={() => router.back()} testID="swap-confirm-back" />
      </Screen>
    );
  }

  // Not sent yet: the confirmation.
  if (create.isIdle && !offlineBlocked) {
    return (
      <Screen gap={space[16]}>
        <PageHeader eyebrowGap={16} teamName={teamName} title={swapConfirmCopy.title} subtitle={swapConfirmCopy.subtitle} />
        <InfoCard title={swapConfirmCopy.give} body={shiftWhen(guess.offered, zone)} testID="swap-give" />
        <InfoCard title={swapConfirmCopy.receive} body={`${guess.counterparty.name} · ${shiftWhen(guess.requested, zone)}`} testID="swap-receive" />
        <Spacer />
        <Button label={swapConfirmCopy.send} onPress={send} testID="swap-send" />
        <Button label={swapConfirmCopy.back} variant="secondary" onPress={() => router.back()} testID="swap-confirm-back" />
      </Screen>
    );
  }

  // The request failed (or was never sent because the device is offline): nothing changed.
  if (create.isError || offlineBlocked) {
    const failure = offlineBlocked ? ({ kind: 'offline' } as const) : describeSwapFailure(create.error);
    const status =
      failure?.kind === 'offline' ? (
        <StatusBanner tone="warning" title={swapFailedCopy.offline.title} body={swapFailedCopy.offline.body} testID="swap-failed" />
      ) : failure?.kind === 'banner' || failure?.kind === 'rate_limited' ? (
        <StatusBanner tone="warning" title={failure.message} body={swapFailedCopy.status.body} testID="swap-failed" />
      ) : (
        <StatusBanner tone="error" title={swapFailedCopy.status.title} body={swapFailedCopy.status.body} reference={failure?.kind === 'generic' && failure.reference ? failure.reference : undefined} testID="swap-failed" />
      );
    return (
      <Screen gap={space[16]}>
        <PageHeader eyebrowGap={16} teamName={teamName} title={swapFailedCopy.title} subtitle={swapFailedCopy.subtitle} />
        {status}
        <Spacer />
        <Button label={swapFailedCopy.retry} onPress={send} testID="swap-retry" />
        <Button label={swapFailedCopy.backToSchedule} variant="secondary" onPress={() => router.dismissTo('/')} testID="swap-failed-back" />
      </Screen>
    );
  }

  // Sent: the guess while the server has not answered yet, then the server's own swap.
  const sending = create.isPending;
  const swap = create.data ?? guess;
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={swapSentCopy.title} subtitle={swapSentCopy.subtitle} />
      <SwapCard swap={swap} timeZone={zone} testID="swap-sent-card" />
      {sending ? (
        <StatusBanner tone="info" title={swapSentCopy.requesting.title} body={swapSentCopy.requesting.body} testID="swap-requesting" />
      ) : (
        <StatusBanner tone="info" title={swapSentCopy.pending.title} body={swapSentCopy.pending.body} testID="swap-sent" />
      )}
      <Spacer />
      {sending ? (
        <Button label={swapSentCopy.requested} onPress={() => {}} disabled testID="swap-requested" />
      ) : (
        <Button label={swapSentCopy.backToSwaps} onPress={() => router.dismissTo('/swaps')} testID="swap-done" />
      )}
    </Screen>
  );
}
