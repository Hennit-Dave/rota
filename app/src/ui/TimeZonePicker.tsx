import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createTeamCopy } from '../auth/copy';
import { filterTimeZones } from '../teams/timeZoneSearch';
import { space, touchSize, useColors } from '../theme';
import { Text } from './Text';
import { TextAction } from './TextAction';
import { TextField } from './TextField';

interface Props {
  visible: boolean;
  zones: readonly string[];
  selected: string | null;
  onSelect: (zone: string) => void;
  onClose: () => void;
  /** The heading; the team's own picker keeps "Team time zone", the person's own setting says "Your time zone". */
  title?: string;
}

/** A full-screen list of time zones with a search field. Plain React Native (no new native module). */
export function TimeZonePicker({ visible, zones, selected, onSelect, onClose, title = createTeamCopy.picker.title }: Props) {
  const colors = useColors();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterTimeZones(zones, query), [zones, query]);
  const close = () => {
    setQuery('');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={close}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: space[24], gap: space[16], flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="heading" accessibilityRole="header">
              {title}
            </Text>
            <TextAction label={createTeamCopy.picker.close} onPress={close} testID="time-zone-close" />
          </View>
          <TextField
            label={createTeamCopy.picker.searchLabel}
            placeholder={createTeamCopy.picker.searchPlaceholder}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            // Focus the search on open: it is what the screen is for, and it keeps Android from drawing its default focus highlight on Close.
            autoFocus
            testID="time-zone-search"
          />
          <FlatList
            data={shown}
            keyExtractor={(zone) => zone}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text variant="body" tone="muted">
                {createTeamCopy.picker.empty}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: item === selected }}
                onPress={() => {
                  setQuery('');
                  onSelect(item);
                }}
                style={{ minHeight: touchSize, justifyContent: 'center' }}
              >
                <Text variant={item === selected ? 'label' : 'body'} tone={item === selected ? 'action' : 'text'}>
                  {item}
                </Text>
              </Pressable>
            )}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
