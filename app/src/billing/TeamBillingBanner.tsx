import { router } from 'expo-router';
import { View } from 'react-native';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { StatusBanner } from '../ui/StatusBanner';
import type { TeamBillingNotice } from '../teams/teamResponses';
import { renewalCopy } from './billingCopy';

/**
 * The team's payment notice on the schedule, for everyone in it (ADR 0031). The text is the server's: the Owner sees the renewal's own words, everyone else only
 * that the team is read-only. Only the Owner gets the button to billing, and only when the server says billing is theirs to manage.
 */
export function TeamBillingBanner({ notice, canManageBilling }: { notice: TeamBillingNotice | null; canManageBilling: boolean }) {
  if (!notice) return null;
  const tone = notice.state === 'read_only' ? 'error' : notice.state === 'past_due' ? 'warning' : 'info';
  return (
    <View style={{ gap: space[12] }} testID="team-billing-banner">
      <StatusBanner tone={tone} title={notice.headline} body={notice.detail} />
      {canManageBilling ? <Button label={renewalCopy.openBilling} variant="outline" onPress={() => router.push('/billing')} testID="team-billing-banner-action" /> : null}
    </View>
  );
}
