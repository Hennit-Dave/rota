import { View } from 'react-native';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { InfoCard } from '../ui/InfoCard';
import { StatusBanner } from '../ui/StatusBanner';
import { Text } from '../ui/Text';
import { describeBillingFailure } from './billingFailure';
import { reductionCopy } from './billingCopy';
import type { ScheduledChange } from './billingResponses';
import { useCancelReduction } from './useBilling';

/**
 * The reduction scheduled for the end of the period, on the billing hub (ADR 0029). Every word of the status is the server's `message`; the Cancel button
 * shows only while the server says `canCancel` (after the check at the boundary it is no longer the Owner's to take back).
 */
export function ScheduledReduction({ change, userId, teamId }: { change: ScheduledChange; userId: string | undefined; teamId: string | null }) {
  const cancel = useCancelReduction(userId, teamId);
  const failure = cancel.isError ? describeBillingFailure(cancel.error) : null;
  const attention = change.status === 'blocked' || change.status === 'continuing';
  return (
    <View style={{ gap: space[12] }}>
      <StatusBanner tone={attention ? 'warning' : 'info'} title={change.status === 'scheduled' ? reductionCopy.bannerTitle(change.effectiveOn) : reductionCopy.bannerChecked} body={change.message} testID="billing-reduction" />
      {change.membersToDeactivate.length > 0 ? (
        <InfoCard title={reductionCopy.inactiveList} testID="billing-reduction-members">
          {change.membersToDeactivate.map((m) => (
            <Text key={m.userId} variant="body">{m.name}</Text>
          ))}
        </InfoCard>
      ) : null}
      {failure ? <StatusBanner tone="warning" title={failure.kind === 'banner' ? failure.message : reductionCopy.cancelFailed} testID="billing-reduction-cancel-failed" /> : null}
      {change.canCancel ? (
        <Button label={reductionCopy.cancel} variant="outline" loading={cancel.isPending} loadingLabel={reductionCopy.cancelling} onPress={() => cancel.mutate()} testID="billing-reduction-cancel" />
      ) : null}
    </View>
  );
}
