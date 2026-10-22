import { Text as RNText, type TextProps } from 'react-native';
import { typography, useColors, type ColorTokens, type TypographyVariant } from '../theme';

interface Props extends TextProps {
  variant?: TypographyVariant;
  tone?: keyof Pick<ColorTokens, 'text' | 'muted' | 'danger' | 'warning' | 'success' | 'action'>;
}

/** The only way screens render text: style comes from the typography tokens, colour from the colour tokens. */
export function Text({ variant = 'body', tone = 'text', style, ...rest }: Props) {
  const colors = useColors();
  return <RNText {...rest} style={[typography[variant], { color: colors[tone] }, style]} />;
}
