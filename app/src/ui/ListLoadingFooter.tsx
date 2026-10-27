import { View } from 'react-native';
import { space } from '../theme';
import { Spinner } from './Spinner';
import { Text } from './Text';

/** "List loading footer" (Figma 102:651): the spinner and "Loading more" under the last row while the next page is on its way. */
export function ListLoadingFooter({ label }: { label: string }) {
  return (
    <View
      testID="list-loading-more"
      accessible
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{ height: 48, flexDirection: 'row', gap: space[8], alignItems: 'center', justifyContent: 'center', paddingVertical: space[12] }}
    >
      <Spinner />
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
}
