import { useMemo } from 'react';
import { SvgXml } from 'react-native-svg';
import { lightColors, useColors } from '../theme';
import * as xml from './icons/figmaIcons';
import { recolour, themeStrokes } from './recolour';

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
 * `color` recolours every stroke. Without it each stroke follows the theme in use (the artwork bakes the light token colours, `themeStrokes` swaps them
 * for the current theme's), so an icon is right in light and dark; on the signed-out side, which is always light, nothing changes.
 */
export function Icon({ name, size, color }: { name: IconName; size: number; color?: string }) {
  const colors = useColors();
  const source = useMemo(
    () => (color ? recolour(sources[name], color) : themeStrokes(sources[name], lightColors, colors)),
    [name, color, colors],
  );
  return <SvgXml xml={source} width={size} height={size} accessible={false} importantForAccessibility="no" />;
}
