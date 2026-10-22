import type { ReactNode } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { space, useColors } from '../theme';

/**
 * The page frame the Figma auth screens share: 24 px sides, content from the top, and a spacer that pushes the footer
 * to the bottom when the content is short. It scrolls when the text size or the keyboard leaves no room, and taps on
 * buttons still work while the keyboard is open.
 */
export function Screen({ children, gap = space[24] }: { children: ReactNode; gap?: number }) {
  const colors = useColors();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, padding: space[24], gap }}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Takes the free space between the content and the footer (Figma "Spacer"). */
export function Spacer() {
  return <View style={{ flex: 1, minHeight: space[8] }} />;
}

/** The divider above the footer link (Figma "Divider"). */
export function Divider() {
  const colors = useColors();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}
