import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityCard } from '../../activity/ActivityCard';
import { ActivitySkeleton } from '../../activity/ActivitySkeleton';
import { activityCopy } from '../../activity/activityCopy';
import { feedState, flattenPages, mayFetchNextPage } from '../../activity/activityPaging';
import type { ActivityItem } from '../../activity/activityResponses';
import { activityDetail, activityLabel } from '../../activity/activityText';
import { useActivity } from '../../activity/useActivity';
import { useScheduleContext } from '../../shifts/useScheduleContext';
import { ApiError } from '../../api/errors';
import { bannerCopy } from '../../auth/copy';
import { ColorsOverrideProvider, lightColors, space, useColors } from '../../theme';
import { AppNav } from '../../ui/AppNav';
import { Button } from '../../ui/Button';
import { EmptyCard } from '../../ui/EmptyCard';
import { ListLoadingFooter } from '../../ui/ListLoadingFooter';
import { PageHeader } from '../../ui/PageHeader';
import { StatusBanner } from '../../ui/StatusBanner';
import { Text } from '../../ui/Text';
import { TextAction } from '../../ui/TextAction';
import { useOnline } from '../../ui/useOnline';

/**
 * Team activity (Figma 04: activity 7:88 and its loading, loading-more, empty, end and error states). The newest changes first, a page at a time: the
 * server's cursor, FlashList, pull to refresh. Opened from Schedule's "View activity"; the bottom bar keeps Schedule selected and pressing it goes back.
 * The next page is asked for only when `mayFetchNextPage` says so (fast scrolling sends no duplicate requests). Light-only for now (issue #24).
 */
export default function ActivityScreen() {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <Activity />
    </ColorsOverrideProvider>
  );
}

function Activity() {
  const colors = useColors();
  const online = useOnline();
  const { userId, teamId, teamName, timeZone, me, detail } = useScheduleContext();
  const feed = useActivity(userId, timeZone ? teamId : null);
  const [now] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);

  const items = flattenPages(feed.data);
  const state = feedState({
    hasData: feed.data !== undefined,
    itemCount: items.length,
    isError: feed.isError || detail.isError || me.isError,
    isFetching: feed.isFetching || detail.isFetching || me.isFetching,
  });
  const zone = timeZone ?? 'UTC';
  const loadFailure = (feed.error ?? detail.error ?? me.error) as unknown;
  const reference = loadFailure instanceof ApiError && loadFailure.requestId ? `${bannerCopy.referencePrefix}${loadFailure.requestId}` : undefined;

  const retry = () => {
    void me.refetch();
    void detail.refetch();
    if (timeZone) feed.retry();
  };

  async function onRefresh() {
    setRefreshing(true);
    try {
      await feed.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  const header = (
    <View style={{ gap: space[16], paddingBottom: space[16] }}>
      <PageHeader eyebrowGap={8} teamName={teamName} title={activityCopy.title} subtitle={activityCopy.subtitle} />
      {state === 'items' ? (
        <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
          {activityCopy.pullHint}
        </Text>
      ) : null}
      {!online && state === 'items' ? <StatusBanner tone="warning" title={activityCopy.offline} testID="activity-offline" /> : null}
    </View>
  );

  let footer: React.ReactNode = null;
  if (state === 'items') {
    if (feed.isFetchingNextPage) footer = <ListLoadingFooter label={activityCopy.loadingMore} />;
    else if (feed.isFetchNextPageError)
      footer = (
        <View style={{ alignItems: 'center', gap: space[4] }} testID="activity-more-failed">
          <Text variant="caption" tone="muted">
            {activityCopy.moreFailed}
          </Text>
          <TextAction label={activityCopy.error.retry} onPress={() => void feed.fetchNextPage()} testID="activity-more-retry" />
        </View>
      );
    else if (!feed.hasNextPage) footer = <EmptyCard title={activityCopy.end.title} body={activityCopy.end.body} testID="activity-end" />;
  }

  let empty: React.ReactNode = null;
  if (state === 'loading') {
    empty = (
      <View key="loading" accessibilityLabel={activityCopy.loading} accessibilityLiveRegion="polite" testID="activity-loading" style={{ gap: space[12] }}>
        {[0, 1, 2, 3].map((k) => (
          <ActivitySkeleton key={k} />
        ))}
      </View>
    );
  } else if (state === 'empty') {
    empty = <EmptyCard title={activityCopy.empty.title} body={activityCopy.empty.body} testID="activity-empty" />;
  } else if (state === 'error') {
    empty = (
      <View key="error" style={{ gap: space[12] }} testID="activity-error">
        <EmptyCard title={activityCopy.error.title} body={activityCopy.error.body} />
        {!online ? <StatusBanner tone="warning" title={activityCopy.offline} /> : reference ? <StatusBanner tone="error" title={activityCopy.error.title} reference={reference} /> : null}
        <Button label={activityCopy.error.retry} variant="secondary" onPress={retry} testID="activity-retry" />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flex: 1 }}>
        <FlashList<ActivityItem>
          data={state === 'items' ? items : []}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={{ paddingBottom: space[12] }}>
              <ActivityCard label={activityLabel(item)} detail={activityDetail(item, now, zone)} testID={`activity-${item.id}`} />
            </View>
          )}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={footer}
          contentContainerStyle={{ padding: space[24], paddingBottom: space[12] }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (mayFetchNextPage({ hasNextPage: feed.hasNextPage, isFetchingNextPage: feed.isFetchingNextPage, isFetchNextPageError: feed.isFetchNextPageError })) {
              void feed.fetchNextPage();
            }
          }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.action} colors={[colors.action]} />}
        />
      </View>
      <View style={{ paddingHorizontal: space[24], paddingBottom: space[24], paddingTop: space[4] }}>
        <AppNav selected="schedule" onReselect={() => router.dismissTo('/')} />
      </View>
    </SafeAreaView>
  );
}
