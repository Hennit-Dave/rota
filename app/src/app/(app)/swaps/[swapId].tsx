import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ApiError } from '../../../api/errors';
import { bannerCopy } from '../../../auth/copy';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { SwapCard } from '../../../swaps/SwapCard';
import { swapListCopy, swapReviewCopy, swapSentCopy } from '../../../swaps/swapCopy';
import { describeSwapFailure, type SwapFailure } from '../../../swaps/swapFailure';
import { swapHeader, swapReviewDetail, swapLabel, shiftWhen } from '../../../swaps/swapText';
import { useSwap, useSwapActions } from '../../../swaps/useSwaps';
import { ColorsOverrideProvider, lightColors, space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { InfoCard } from '../../../ui/InfoCard';
import { createLatch } from '../../../ui/latch';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { useOnline } from '../../../ui/useOnline';

/**
 * One swap: "Review swap" for an Owner or Manager who may decide it (Figma swap-review 8:367), and the same screen as "Request sent", "Swap approved" (8:381)
 * or "Swap not approved" (8:394) for everyone else, by what the swap is now. The buttons are the server's answer (`canDecide`, `canCancel`); the server checks
 * again on every press, and a refusal (a shift changed, someone would be double-booked) is shown here. Light-only for now (issue #24).
 */
export default function SwapScreen() {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <SwapDetail />
    </ColorsOverrideProvider>
  );
}

function SwapDetail() {
  const online = useOnline();
  const { swapId } = useLocalSearchParams<{ swapId: string }>();
  const { userId, teamId, teamName, timeZone } = useScheduleContext();
  const swap = useSwap(userId, teamId, swapId);
  const { cancel, decide } = useSwapActions(userId, teamId);
  const [problem, setProblem] = useState<SwapFailure | null>(null);
  const [latch] = useState(createLatch);
  const zone = timeZone ?? 'UTC';
  const busy = cancel.isPending || decide.isPending;

  const gone = problem?.kind === 'gone' || (swap.error instanceof ApiError && swap.error.code === 'not_found');
  if (gone || !swap.data) {
    const reference = swap.error instanceof ApiError && swap.error.requestId ? `${bannerCopy.referencePrefix}${swap.error.requestId}` : undefined;
    return (
      <Screen gap={space[16]}>
        <PageHeader
          eyebrowGap={16}
          teamName={teamName}
          title={gone ? swapReviewCopy.notFound.title : swap.isError ? swapListCopy.error.title : swapReviewCopy.loading}
          subtitle={gone ? swapReviewCopy.notFound.subtitle : undefined}
        />
        {swap.isError && !gone ? <StatusBanner tone="error" title={swapListCopy.error.title} reference={reference} /> : null}
        {!swap.isError && !gone ? (
          <Text variant="caption" tone="muted">
            {swapReviewCopy.loading}
          </Text>
        ) : null}
        <Spacer />
        {swap.isError && !gone ? <Button label={swapListCopy.error.retry} variant="secondary" onPress={() => void swap.refetch()} testID="swap-retry" /> : null}
        <Button label={swapReviewCopy.rejected.back} onPress={() => router.dismissTo('/swaps')} testID="swap-back" />
      </Screen>
    );
  }

  const data = swap.data;
  const header = swapHeader(data);

  async function act(run: () => Promise<unknown>) {
    if (!latch.tryAcquire()) return;
    setProblem(null);
    try {
      await run();
    } catch (error) {
      setProblem(describeSwapFailure(error));
    } finally {
      latch.release();
    }
  }

  let banner: React.ReactNode = null;
  if (problem) {
    banner =
      problem.kind === 'offline' ? (
        <StatusBanner tone="warning" title={bannerCopy.offline} testID="swap-problem" />
      ) : problem.kind === 'generic' ? (
        <StatusBanner tone="error" title={bannerCopy.generic} reference={problem.reference ? `${bannerCopy.referencePrefix}${problem.reference}` : undefined} testID="swap-problem" />
      ) : (
        <StatusBanner tone="warning" title={problem.message} testID="swap-problem" />
      );
  } else if (data.status === 'pending' && !data.canDecide) {
    banner = <StatusBanner tone="info" title={swapSentCopy.pending.title} body={swapSentCopy.pending.body} testID="swap-waiting" />;
  }

  const finished = data.status !== 'pending';
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={header.title} subtitle={header.subtitle} />
      {data.canDecide ? (
        <InfoCard title={`${data.requester.name} ↔ ${data.counterparty.name}`} body={swapReviewDetail(data, zone)} testID="swap-review-card" />
      ) : (
        <SwapCard swap={data} timeZone={zone} testID="swap-card" />
      )}
      <InfoCard title={swapLabel(data)} body={`${data.requester.name}: ${shiftWhen(data.offered, zone)}\n${data.counterparty.name}: ${shiftWhen(data.requested, zone)}`} testID="swap-who" />
      {banner}
      <Spacer />
      {data.canDecide ? (
        <>
          <Button
            label={swapReviewCopy.approve}
            loading={decide.isPending && decide.variables?.decision === 'approve'}
            loadingLabel={swapReviewCopy.approving}
            disabled={!online || busy}
            onPress={() => void act(() => decide.mutateAsync({ swapId: data.id, decision: 'approve' }))}
            testID="swap-approve"
          />
          <Button
            label={swapReviewCopy.reject}
            variant="danger"
            loading={decide.isPending && decide.variables?.decision === 'reject'}
            loadingLabel={swapReviewCopy.rejecting}
            disabled={!online || busy}
            onPress={() => void act(() => decide.mutateAsync({ swapId: data.id, decision: 'reject' }))}
            testID="swap-reject"
          />
        </>
      ) : null}
      {data.canCancel ? (
        <Button
          label={swapReviewCopy.cancel}
          variant="secondary"
          loading={cancel.isPending}
          loadingLabel={swapReviewCopy.cancelling}
          disabled={!online || busy}
          onPress={() => void act(() => cancel.mutateAsync(data.id))}
          testID="swap-cancel"
        />
      ) : null}
      {data.status === 'approved' ? (
        <Button label={swapReviewCopy.approved.view} onPress={() => router.dismissTo('/')} testID="swap-view-schedule" />
      ) : null}
      {finished || (!data.canDecide && !data.canCancel) ? (
        <Button label={swapReviewCopy.rejected.back} variant={data.status === 'approved' ? 'secondary' : 'primary'} onPress={() => router.dismissTo('/swaps')} testID="swap-back" />
      ) : null}
    </Screen>
  );
}
