import { router } from 'expo-router';
import { View } from 'react-native';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { StatusBanner } from '../ui/StatusBanner';
import { activateCopy } from './billingCopy';
import { useBillingOverview } from './useBilling';

/**
 * The Owner's reminder on the schedule while the team has not activated (ADR 0026: an unactivated team works within Starter's limits, nothing is read-only).
 * It exists only for a person the server says may manage billing, and only while the server says the team has no subscription. It shows nothing while
 * loading or on an error: a missing reminder is harmless and the billing screen is one tap away elsewhere.
 */
export function ActivateBanner({ userId, teamId, canManageBilling }: { userId: string | undefined; teamId: string | null; canManageBilling: boolean }) {
  const overview = useBillingOverview(userId, teamId, canManageBilling);
  if (!canManageBilling || overview.data === undefined || overview.data.activated) return null;
  return (
    <View style={{ gap: space[12] }} testID="activate-banner">
      <StatusBanner tone="info" title={activateCopy.bannerTitle} body={activateCopy.bannerBody} />
      <Button label={activateCopy.bannerAction} variant="outline" onPress={() => router.push('/billing')} testID="activate-banner-action" />
    </View>
  );
}
