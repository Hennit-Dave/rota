import { router } from 'expo-router';
import { View } from 'react-native';
import { BillingHeader } from '../../../billing/BillingHeader';
import { historyCopy } from '../../../billing/billingCopy';
import type { HistoryEntry } from '../../../billing/billingResponses';
import { useBillingHistory } from '../../../billing/useBilling';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { EmptyCard } from '../../../ui/EmptyCard';
import { InfoCard } from '../../../ui/InfoCard';
import { Screen, Spacer } from '../../../ui/Screen';
import { SkeletonBlock } from '../../../ui/SkeletonBlock';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { useOnline } from '../../../ui/useOnline';

/**
 * Billing history (Figma 07 "billing-history"; not compared frame by frame yet): what the team paid and every plan or seat change, newest first, read from the
 * ledger by the server. Every amount and every date is the server's text. Loading, empty, error and end-of-list states are all shown.
 */
export default function BillingHistoryScreen() {
  const online = useOnline();
  const { userId, teamId, teamName, detail } = useScheduleContext();
  const canManage = detail.data?.canManageBilling === true;
  const history = useBillingHistory(userId, teamId, canManage);

  const header = <BillingHeader teamName={teamName} title={historyCopy.title} subtitle={historyCopy.subtitle} />;
  const back = <Button label={historyCopy.back} variant="secondary" onPress={() => router.back()} testID="history-back" />;

  if (history.isError) {
    return (
      <Screen gap={space[16]}>
        {header}
        <StatusBanner tone={online ? 'error' : 'warning'} title={historyCopy.error.title} body={historyCopy.error.body} testID="history-error" />
        <Button label={historyCopy.error.retry} variant="secondary" onPress={() => void history.refetch()} testID="history-retry" />
        <Spacer />
        {back}
      </Screen>
    );
  }
  if (history.data === undefined) {
    return (
      <Screen gap={space[16]}>
        {header}
        <View accessibilityLabel={historyCopy.loading} testID="history-loading" style={{ gap: space[12] }}>
          <SkeletonBlock />
          <SkeletonBlock />
        </View>
        <Spacer />
        {back}
      </Screen>
    );
  }
  return (
    <Screen gap={space[12]}>
      {header}
      {history.data.history.length === 0 ? (
        <EmptyCard title={historyCopy.empty.title} body={historyCopy.empty.body} testID="history-empty" />
      ) : (
        history.data.history.map((entry) => <HistoryCard key={entry.id} entry={entry} />)
      )}
      <Text variant="caption" tone="muted" testID="history-end">
        {history.data.hasMore ? historyCopy.hasMore : historyCopy.end}
      </Text>
      <Spacer />
      {back}
    </Screen>
  );
}

function HistoryCard({ entry }: { entry: HistoryEntry }) {
  return (
    <InfoCard title={`${entry.date} · ${entry.title}`} body={entry.detail ? `${entry.detail} · ${entry.netDisplay}` : entry.netDisplay} testID={`history-${entry.id}`}>
      {entry.lines.map((line) => (
        <Text key={`${entry.id}-${line.label}`} variant="caption" tone="muted">{`${line.label}  ${line.amountDisplay}`}</Text>
      ))}
    </InfoCard>
  );
}
