import { SvgXml } from 'react-native-svg';
import * as xml from './icons/figmaIcons';
import { recolour } from './recolour';

export type IconName =
  | 'eye'
  | 'eyeOff'
  | 'chevronDown'
  | 'alert'
  | 'statusError'
  | 'statusWarning'
  | 'statusInfo'
  | 'spinner'
  | 'check'
  | 'navSchedule'
  | 'navTeam'
  | 'navSwaps'
  | 'navSettings'
  | 'calendar'
  | 'clock';

const sources: Record<IconName, string> = {
  eye: xml.eyeXml,
  eyeOff: xml.eyeOffXml,
  chevronDown: xml.chevronDownXml,
  alert: xml.alertXml,
  statusError: xml.statusErrorXml,
  statusWarning: xml.statusWarningXml,
  statusInfo: xml.statusInfoXml,
  spinner: xml.spinnerXml,
  check: xml.checkXml,
  navSchedule: xml.navScheduleXml,
  navTeam: xml.navTeamXml,
  navSwaps: xml.navSwapsXml,
  navSettings: xml.navSettingsXml,
  calendar: xml.calendarXml,
  clock: xml.clockXml,
};

/**
 * The Figma artwork at the size it was designed (each SVG carries its own width and height). Decorative: hidden from screen readers.
 * `color` recolours the strokes (the signed-in side follows the theme; the auth icons keep their baked light colours).
 */
export function Icon({ name, size, color }: { name: IconName; size: number; color?: string }) {
  const source = color ? recolour(sources[name], color) : sources[name];
  return <SvgXml xml={source} width={size} height={size} accessible={false} importantForAccessibility="no" />;
}
