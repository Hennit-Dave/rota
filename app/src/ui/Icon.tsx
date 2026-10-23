import { SvgXml } from 'react-native-svg';
import * as xml from './icons/figmaIcons';

export type IconName = 'eye' | 'eyeOff' | 'chevronDown' | 'alert' | 'statusError' | 'statusWarning' | 'statusInfo' | 'spinner';

const sources: Record<IconName, string> = {
  eye: xml.eyeXml,
  eyeOff: xml.eyeOffXml,
  chevronDown: xml.chevronDownXml,
  alert: xml.alertXml,
  statusError: xml.statusErrorXml,
  statusWarning: xml.statusWarningXml,
  statusInfo: xml.statusInfoXml,
  spinner: xml.spinnerXml,
};

/** The Figma artwork at the size it was designed (each SVG carries its own width and height). Decorative: hidden from screen readers. */
export function Icon({ name, size }: { name: IconName; size: number }) {
  return <SvgXml xml={sources[name]} width={size} height={size} accessible={false} importantForAccessibility="no" />;
}
