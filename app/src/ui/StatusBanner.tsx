import { View } from 'react-native';
import { radius, space, useColors, type ColorTokens } from '../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type StatusTone = 'error' | 'warning' | 'info';

const toneStyle: Record<StatusTone, { surface: keyof ColorTokens; text: 'danger' | 'warning' | 'action'; icon: IconName }> = {
  error: { surface: 'dangerSurface', text: 'danger', icon: 'statusError' },
  warning: { surface: 'warningSurface', text: 'warning', icon: 'statusWarning' },
  info: { surface: 'accent', text: 'action', icon: 'statusInfo' },
};

interface Props {
  tone: StatusTone;
  title: string;
  body?: string;
  /** A selectable line under the text, for a support reference. */
  reference?: string;
  testID?: string;
}

/** Rota Status (Figma 5:68): an icon, a title in the tone colour, and an optional muted line. Announced politely when it appears. */
export function StatusBanner({ tone, title, body, reference, testID }: Props) {
  const colors = useColors();
  const style = toneStyle[tone];
  return (
    <View
      testID={testID}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        gap: space[12],
        alignItems: 'flex-start',
        padding: space[16],
        borderRadius: radius[12],
        backgroundColor: colors[style.surface],
      }}
    >
      <Icon name={style.icon} size={24} />
      <View style={{ flex: 1, minWidth: 0, gap: space[8] }}>
        <Text variant="label" tone={style.text}>
          {title}
        </Text>
        {body ? (
          <Text variant="caption" tone="muted">
            {body}
          </Text>
        ) : null}
        {reference ? (
          <Text variant="caption" tone="muted" selectable>
            {reference}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
