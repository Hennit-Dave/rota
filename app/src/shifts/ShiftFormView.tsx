import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useMembers } from '../teams/useTeamData';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { createLatch } from '../ui/latch';
import { OptionSheet } from '../ui/OptionSheet';
import { SelectField } from '../ui/SelectField';
import { StatusBanner } from '../ui/StatusBanner';
import { Text } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { useOnline } from '../ui/useOnline';
import { shiftFormCopy } from './shiftCopy';
import { validateShiftForm, type ShiftFormErrors, type ShiftFormValues } from './shiftForm';
import type { ShiftFailure } from './shiftFailure';

const OPEN = 'open';

interface Props {
  mode: 'create' | 'edit';
  initial: ShiftFormValues;
  timeZone: string;
  userId: string | undefined;
  teamId: string | null;
  /** Edit only: the shift's current assignee, shown by name even if the roster no longer lists them (the server rejects keeping them only if they truly left). */
  fallbackAssignee?: { id: string; name: string } | null;
  /** Called with the validated instants. Resolve when the server answered; throw to leave the form open (the screen shows the failure). */
  onSubmit: (values: ShiftFormValues, startsAt: Date, endsAt: Date) => Promise<void>;
  /** What the last attempt's failure looks like; the screen maps it with describeShiftFailure. */
  failure: ShiftFailure | null;
  pending: boolean;
}

/**
 * The create and edit form (Figma 7:67 and 10:317): title, date, start, end and who is assigned. Labels sit above the fields. Only presence and shape are
 * checked here, when the button is tapped; the overlap, the length caps and who is on the team are the server's decision and come back as errors. Dates and
 * times are typed (a native picker would need a new build) and read on the TEAM'S wall clock.
 */
export function ShiftFormView({ mode, initial, timeZone, userId, teamId, fallbackAssignee, onSubmit, failure, pending }: Props) {
  const online = useOnline();
  const members = useMembers(userId, teamId);
  const latch = useRef(createLatch()).current;
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<ShiftFormErrors>({});
  const [sheet, setSheet] = useState(false);

  const set = (patch: Partial<ShiftFormValues>) => setValues((v) => ({ ...v, ...patch }));
  const fieldErrors: ShiftFormErrors = { ...errors, ...(failure?.kind === 'fields' ? failure.fields : {}) };
  const assignee =
    values.assigneeId === null
      ? null
      : (members.data?.find((m) => m.userId === values.assigneeId)?.name ?? (fallbackAssignee?.id === values.assigneeId ? fallbackAssignee.name : null));
  const options = [{ value: OPEN, label: shiftFormCopy.openShiftOption }, ...(members.data ?? []).map((m) => ({ value: m.userId, label: m.name }))];

  async function submit() {
    if (pending || !latch.tryAcquire()) return;
    try {
      const result = validateShiftForm(values, timeZone);
      setErrors(result.errors);
      if (!result.startsAt || !result.endsAt) return;
      try {
        await onSubmit(values, result.startsAt, result.endsAt);
      } catch {
        // The screen already shows the failure.
      }
    } finally {
      latch.release();
    }
  }

  const label = mode === 'create' ? shiftFormCopy.publish : shiftFormCopy.save;
  const loadingLabel = mode === 'create' ? shiftFormCopy.publishing : shiftFormCopy.saving;
  const banner =
    failure && failure.kind !== 'fields' && failure.kind !== 'gone' ? (
      <StatusBanner
        tone={failure.kind === 'generic' ? 'error' : 'warning'}
        title={failure.message}
        reference={failure.kind === 'generic' && failure.reference ? failure.reference : undefined}
        testID="shift-form-failure"
      />
    ) : null;

  return (
    <View style={{ gap: space[16] }}>
      <TextField
        label={shiftFormCopy.titleLabel}
        value={values.title}
        onChangeText={(title) => set({ title })}
        placeholder={shiftFormCopy.titlePlaceholder}
        error={fieldErrors.title}
        autoCapitalize="sentences"
        testID="shift-title"
      />
      <TextField
        label={shiftFormCopy.dateLabel}
        value={values.date}
        onChangeText={(date) => set({ date })}
        placeholder={shiftFormCopy.datePlaceholder}
        error={fieldErrors.date}
        trailingIcon="calendar"
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        testID="shift-date"
      />
      <View style={{ flexDirection: 'row', gap: space[12] }}>
        <View style={{ flex: 1 }}>
          <TextField
            label={shiftFormCopy.startLabel}
            value={values.start}
            onChangeText={(start) => set({ start })}
            placeholder={shiftFormCopy.timePlaceholderStart}
            error={fieldErrors.start}
            trailingIcon="clock"
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
            testID="shift-start"
          />
        </View>
        <View style={{ flex: 1 }}>
          <TextField
            label={shiftFormCopy.endLabel}
            value={values.end}
            onChangeText={(end) => set({ end })}
            placeholder={shiftFormCopy.timePlaceholderEnd}
            error={fieldErrors.end}
            trailingIcon="clock"
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
            testID="shift-end"
          />
        </View>
      </View>
      <Text variant="caption" tone="muted">
        {shiftFormCopy.overnightHint}
      </Text>
      <SelectField
        label={mode === 'create' ? shiftFormCopy.assigneeLabel : shiftFormCopy.assigneeEditLabel}
        value={assignee}
        placeholder={shiftFormCopy.assigneePlaceholder}
        onPress={() => setSheet(true)}
        disabled={pending || members.data === undefined}
        testID="shift-assignee"
      />
      {mode === 'create' ? (
        <Text variant="caption" tone="muted">
          {shiftFormCopy.supporting}
        </Text>
      ) : null}
      {banner}
      <Button
        label={label}
        loading={pending}
        loadingLabel={loadingLabel}
        disabled={!online}
        onPress={() => void submit()}
        testID="shift-submit"
      />
      <OptionSheet
        visible={sheet}
        title={shiftFormCopy.assigneeSheet}
        options={options}
        selected={values.assigneeId ?? OPEN}
        onSelect={(value) => {
          set({ assigneeId: value === OPEN ? null : value });
          setSheet(false);
        }}
        onClose={() => setSheet(false)}
      />
    </View>
  );
}
