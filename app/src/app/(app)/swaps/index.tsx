import { router } from 'expo-router';
import { View } from 'react-native';
import { ApiError } from '../../../api/errors';
import { bannerCopy } from '../../../auth/copy';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { SwapCard } from '../../../swaps/SwapCard';
import { swapListCopy } from '../../../swaps/swapCopy';
import { orderSwaps } from '../../../swaps/swapOptimistic';
import { useSwaps } from '../../../swaps/useSwaps';
import { space } from '../../../theme';
import { AppNav } from '../../../ui/AppNav';
import { Button } from '../../../ui/Button';
import { EmptyCard } from '../../../ui/EmptyCard';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';
import { SkeletonBlock } from '../../../ui/SkeletonBlock';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { useOnline } from '../../../ui/useOnline';

/**
 * Shift swaps (Figma 06: swaps 8:296). Your own requests, and for an Owner or Manager every request waiting for a decision (the server decides what each
 * person sees). Anyone may ask for a swap.
 */
export default function SwapsScreen() {
  return <Swaps />;
}

function Swaps() {
  const online = useOnline();
  const { userId, teamId, teamName, timeZone, detail } = useScheduleContext();
  const swaps = useSwaps(userId, timeZone ? teamId : null);
  const zone = timeZone ?? 'UTC';
  const list = swaps.data ? orderSwaps(swaps.data) : [];
  const forMe = list.filter((s) => s.status === 'pending' && s.canDecide);
  const rest = list.filter((s) => !(s.status === 'pending' && s.canDecide));
  const failure = (swaps.error ?? detail.error) as unknown;
  const reference = failure instanceof ApiError && failure.requestId ? `${bannerCopy.referencePrefix}${failure.requestId}` : undefined;
  const open = (swapId: string) => router.push({ pathname: '/swaps/[swapId]', params: { swapId } });

  const card = (swap: (typeof list)[number]) => <SwapCard key={swap.id} swap={swap} timeZone={zone} onPress={() => open(swap.id)} testID={`swap-${swap.id}`} />;

  let body: React.ReactNode;
  if (swaps.data) {
    body =
      list.length === 0 ? (
        <EmptyCard title={swapListCopy.empty.title} body={swapListCopy.empty.body} testID="swaps-empty" />
      ) : (
        <>
          {!online ? <StatusBanner tone="warning" title={swapListCopy.offline} testID="swaps-offline" /> : null}
          {forMe.length > 0 ? (
            <>
              <Text variant="caption" tone="muted">
                {swapListCopy.review}
              </Text>
              {forMe.map(card)}
            </>
          ) : null}
          {rest.length > 0 ? (
            <>
              {forMe.length > 0 ? (
                <Text variant="caption" tone="muted">
                  {swapListCopy.other}
                </Text>
              ) : null}
              {rest.map(card)}
            </>
          ) : null}
        </>
      );
  } else if (swaps.isError || detail.isError) {
    body = (
      <View style={{ gap: space[12] }} testID="swaps-error">
        <EmptyCard title={swapListCopy.error.title} body={swapListCopy.error.body} />
        {!online ? <StatusBanner tone="warning" title={swapListCopy.offline} /> : reference ? <StatusBanner tone="error" title={swapListCopy.error.title} reference={reference} /> : null}
        <Button
          label={swapListCopy.error.retry}
          variant="secondary"
          onPress={() => {
            void detail.refetch();
            void swaps.refetch();
          }}
          testID="swaps-retry"
        />
      </View>
    );
  } else {
    body = (
      <View accessibilityLabel={swapListCopy.loading} testID="swaps-loading" style={{ gap: space[12] }}>
        <SkeletonBlock />
        <SkeletonBlock />
      </View>
    );
  }

  return (
    <Screen gap={space[12]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={swapListCopy.title} subtitle={swapListCopy.subtitle} />
      {body}
      <Spacer />
      <Button label={swapListCopy.request} onPress={() => router.push('/swaps/new')} disabled={!online} testID="swaps-request" />
      <AppNav selected="swaps" />
    </Screen>
  );
}
