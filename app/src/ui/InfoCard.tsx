import type { ReactNode } from 'react';
import { View } from 'react-native';
import { radius, space, useColors } from '../theme';
import { Text } from './Text';

interface Props {
  title: string;
  body?: string;
  children?: ReactNode;
  testID?: string;
}

/** The white content card of the invite screens (Figma "Team and role" 100:201, "Staff access" 8:141): a label and a muted line. */
export function InfoCard({ title, body, children, testID }: Props) {
  const colors = useColors();
  return (
    <View testID={testID} style={{ backgroundColor: colors.surface, borderRadius: radius[12], padding: space[16], gap: space[8] }}>
      <Text variant="label">{title}</Text>
      {body ? (
        <Text variant="body" tone="muted">
          {body}
        </Text>
      ) : null}
      {children}
    </View>
  );
}
