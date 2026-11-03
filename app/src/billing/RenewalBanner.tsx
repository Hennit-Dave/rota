import { router } from 'expo-router';
import { View } from 'react-native';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { StatusBanner } from '../ui/StatusBanner';
import { Text } from '../ui/Text';
import { describeBillingFailure } from './billingFailure';
import { renewalCopy } from './billingCopy';
import type { Renewal } from './billingResponses';
import { useRetryRenewal } from './useBilling';

/**
 * The Owner's renewal banner on the billing hub (ADR 0031). Every word is the server's: the headline, the reason, the amount and the last day of full access. The
 * Retry button shows only while the server says `canRetry`; pressing it asks the server to charge again and the server answers "confirming" (the app never decides
 * that a payment worked: the hub asks again every few seconds until the server settles it).
 */
export function RenewalBanner({ renewal, userId, teamId }: { renewal: Renewal; userId: string | undefined; teamId: string | null }) {
  const retry = useRetryRenewal(userId, teamId);
  const failure = retry.isError ? describeBillingFailure(retry.error) : null;
  const tone = renewal.state === 'read_only' ? 'error' : renewal.state === 'past_due' ? 'warning' : 'info';
  return (
    <View style={{ gap: space[12] }} testID="billing-renewal">
      <StatusBanner tone={tone} title={renewal.headline} body={renewal.detail} testID="billing-renewal-banner" />
      {renewal.amountDisplay ? <Text variant="caption" tone="muted">{renewalCopy.amount(renewal.amountDisplay)}</Text> : null}
      {failure ? <StatusBanner tone="warning" title={failure.kind === 'banner' ? failure.message : renewalCopy.retryFailed} testID="billing-renewal-retry-failed" /> : null}
      {renewal.canRetry ? (
        <>
          <Button label={renewalCopy.retry} loading={retry.isPending} loadingLabel={renewalCopy.retrying} onPress={() => retry.mutate()} testID="billing-renewal-retry" />
          <Button label={renewalCopy.fixCard} variant="outline" onPress={() => router.push('/billing/card')} testID="billing-renewal-fix-card" />
        </>
      ) : null}
    </View>
  );
}
