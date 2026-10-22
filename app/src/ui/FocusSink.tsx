import { createContext, useCallback, useContext, useRef, type ComponentRef, type ReactNode } from 'react';
import { TextInput, View } from 'react-native';

const FocusSinkContext = createContext<() => void>(() => {});

/**
 * One hidden text input at the root, to park keyboard focus on. Why: when the focused input is disabled during a request (or blurred),
 * Android hands focus to the first focusable view it finds, the ScrollView, and draws its default focus highlight over the whole page: a
 * uniform 7% dim of the content area, found on the emulator. React Native's focusable={false} is not honoured by ScrollView on Android, and a
 * plain zero-size view is not focusable in touch mode, so a submit moves focus here on purpose (useFocusSink). It shows no keyboard, no caret
 * and nothing on screen, and focusing it closes the keyboard.
 */
export function FocusSinkProvider({ children }: { children: ReactNode }) {
  const sink = useRef<ComponentRef<typeof TextInput>>(null);
  const focusSink = useCallback(() => sink.current?.focus(), []);
  return (
    <FocusSinkContext.Provider value={focusSink}>
      <View style={{ flex: 1 }}>
        {children}
        <TextInput
          ref={sink}
          showSoftInputOnFocus={false}
          caretHidden
          importantForAccessibility="no"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
        />
      </View>
    </FocusSinkContext.Provider>
  );
}

/** Call on submit: closes the keyboard and parks focus on the hidden sink, so nothing visible is left holding it. */
export function useFocusSink(): () => void {
  return useContext(FocusSinkContext);
}
