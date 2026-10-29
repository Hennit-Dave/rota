import { View } from 'react-native';
import { space, useColors } from '../theme';
import { PageHeader } from '../ui/PageHeader';
import { Text } from '../ui/Text';
import { billingBadgeCopy } from './billingCopy';

/** The amber "Test mode" pill of the Figma 07 Billing frames: shown on every billing screen, so nobody mistakes this for real money. */
export function TestModeBadge() {
  const colors = useColors();
  return (
    <View
      accessible
      accessibilityLabel={billingBadgeCopy.testMode}
      testID="test-mode-badge"
      style={{ alignSelf: 'flex-start', backgroundColor: colors.warningSurface, borderRadius: 999, paddingHorizontal: space[12], paddingVertical: space[4] }}
    >
      <Text variant="label" style={{ color: colors.warning }}>
        {billingBadgeCopy.testMode}
      </Text>
    </View>
  );
}

/** The header of every billing screen: the page header and, under it, the Test mode badge (Figma 07: "Screen header" holds both). */
export function BillingHeader(props: { title: string; subtitle?: string; teamName?: string }) {
  return (
    <View style={{ gap: space[12] }}>
      <PageHeader eyebrowGap={16} teamName={props.teamName} title={props.title} subtitle={props.subtitle} />
      <TestModeBadge />
    </View>
  );
}
