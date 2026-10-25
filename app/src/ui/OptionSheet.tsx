import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, space, useColors } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';

interface Option {
  value: string;
  label: string;
}

interface Props {
  visible: boolean;
  title: string;
  options: readonly Option[];
  selected: string | null;
  onSelect: (value: string) => void;
  onClose: () => void;
}

/**
 * Rota "Role sheet" (Figma 291:978): a white sheet with 20 px top corners rising from the bottom over a dimmed screen, a Heading, and 52 px
 * options; the chosen one has the mint background and the check. Plain React Native Modal (no new native module). Tapping outside, or Back, closes it.
 */
export function OptionSheet({ visible, title, options, selected, onSelect, onClose }: Props) {
  const colors = useColors();
  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        {/* Figma "Scrim" (291:977): the text colour token at 40%. */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.text, opacity: 0.4 }]} />
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onClose} style={{ flex: 1 }} />
        <SafeAreaView
          edges={['bottom']}
          style={{ backgroundColor: colors.surface, borderTopLeftRadius: radius[20], borderTopRightRadius: radius[20] }}
        >
          <View style={{ padding: space[16], gap: space[8] }}>
            <Text variant="heading" accessibilityRole="header">
              {title}
            </Text>
            {options.map((option) => {
              const isSelected = option.value === selected;
              return (
                <Pressable
                  key={option.value}
                  testID={`option-${option.value}`}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => onSelect(option.value)}
                  style={{
                    minHeight: 52,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: space[12],
                    borderRadius: radius[12],
                    backgroundColor: isSelected ? colors.accent : 'transparent',
                  }}
                >
                  <Text variant="body" style={{ flex: 1 }}>
                    {option.label}
                  </Text>
                  {isSelected ? <Icon name="check" size={24} /> : null}
                </Pressable>
              );
            })}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
