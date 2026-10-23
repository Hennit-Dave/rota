import { View } from 'react-native';
import { ROTA_EYEBROW } from '../auth/copy';
import { space } from '../theme';
import { Text } from './Text';

interface Props {
  title: string;
  subtitle?: string;
  /** Figma uses 8 under the eyebrow on the form screens and 16 on the state screens ("Header Group"). */
  eyebrowGap?: 8 | 16;
  /** In-team screens: the eyebrow reads "ROTA   /   THE OLIVE ROOM" (Figma). */
  teamName?: string;
}

/** The ROTA eyebrow, a title and a muted line. The title is exposed as a heading to screen readers. */
export function PageHeader({ title, subtitle, eyebrowGap = 8, teamName }: Props) {
  return (
    <View style={{ gap: eyebrowGap }}>
      <Text variant="caption" tone="action">
        {teamName ? `${ROTA_EYEBROW}   /   ${teamName.toUpperCase()}` : ROTA_EYEBROW}
      </Text>
      <View style={{ gap: space[8] }}>
        <Text variant="title" accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="body" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
