import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { bannerCopy, createTeamCopy } from '../../auth/copy';
import { useMe } from '../../auth/useMe';
import { queryClient, getTeamApi } from '../../services';
import { useSessionStore } from '../../state/sessionStore';
import { createTeamFieldOrder, validateCreateTeam, type CreateTeamField, type CreateTeamFieldErrors } from '../../teams/createTeamValidation';
import { describeCreateTeamFailure, type CreateTeamFailure } from '../../teams/createTeamFailure';
import { teamsQueryKey, type TeamSummary } from '../../teams/teamResponses';
import { defaultTimeZone, deviceTimeZone } from '../../teams/timeZoneSearch';
import { timeZones } from '../../teams/timeZones';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { useFocusSink } from '../../ui/FocusSink';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { SelectField } from '../../ui/SelectField';
import { StatusBanner } from '../../ui/StatusBanner';
import { TextField, type TextFieldHandle } from '../../ui/TextField';
import { TimeZonePicker } from '../../ui/TimeZonePicker';
import { useOnline } from '../../ui/useOnline';

/**
 * Create team (Figma 8:101): the step after sign-up, and where a signed-in user with no team lands. The creator becomes the Owner.
 * Figma's "Next step" banner and its "Continue to plan selection" button wait for the
 * billing slice: nothing here mentions plans.
 */
export default function CreateTeamScreen() {
  return <CreateTeamForm />;
}

type Failure = Exclude<CreateTeamFailure, { kind: 'fields' }>;

function CreateTeamForm() {
  const online = useOnline();
  const focusSink = useFocusSink();
  const me = useMe();
  const userId = me.data?.id;
  const [name, setName] = useState('');
  const [timeZone, setTimeZone] = useState<string | null>(() => defaultTimeZone(timeZones, deviceTimeZone));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<CreateTeamFieldErrors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const nameRef = useRef<TextFieldHandle>(null);

  // Never queued offline (app-state.md): it runs and fails at once, and the button is disabled while offline anyway.
  const create = useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: (input: { name: string; timeZone: string }) => getTeamApi().createTeam(input),
    onSuccess: (team) => {
      if (userId) {
        // Seed the list with the server's answer so home shows the team at once; the refetch below replaces it with the server's version.
        queryClient.setQueryData<TeamSummary[]>(teamsQueryKey(userId), (previous) => [...(previous ?? []).filter((t) => t.id !== team.id), team]);
        void queryClient.invalidateQueries({ queryKey: teamsQueryKey(userId) });
      }
      useSessionStore.getState().selectTeam(team.id);
      router.replace('/');
    },
  });
  const submitting = create.isPending;

  function focusField(field: CreateTeamField | null) {
    if (field === 'name') nameRef.current?.focus();
    if (field === 'timeZone') setPickerOpen(true);
  }

  function submit() {
    if (submitting) return;
    const errors = validateCreateTeam({ name, timeZone });
    setFieldErrors(errors);
    const invalid = createTeamFieldOrder.find((field) => errors[field] !== undefined) ?? null;
    if (invalid || timeZone === null) {
      focusField(invalid);
      return;
    }
    focusSink(); // the focused field is about to be disabled: park focus first (closes the keyboard too)
    setFailure(null);
    create.mutate(
      { name, timeZone },
      {
        onError: (error) => {
          const result = describeCreateTeamFailure(error);
          if (!result) return; // a result for a previous account: show nothing
          if (result.kind === 'fields') {
            setFieldErrors(result.fields);
            focusField(createTeamFieldOrder.find((field) => result.fields[field] !== undefined) ?? null);
          } else {
            setFailure(result);
          }
        },
      },
    );
  }

  let banner: React.ReactNode = null;
  if (!online) {
    banner = <StatusBanner tone="warning" title={bannerCopy.offline} />;
  } else if (failure?.kind === 'rate_limited' || failure?.kind === 'offline') {
    banner = <StatusBanner tone="warning" title={failure.message} />;
  } else if (failure?.kind === 'generic') {
    banner = (
      <StatusBanner
        tone="error"
        title={failure.message}
        reference={failure.reference ? `${bannerCopy.referencePrefix}${failure.reference}` : undefined}
      />
    );
  }

  return (
    <Screen>
      <PageHeader eyebrowGap={16} title={createTeamCopy.title} subtitle={createTeamCopy.subtitle} />
      <View style={{ gap: space[16] }}>
        <TextField
          label={createTeamCopy.nameLabel}
          helper={createTeamCopy.nameHelper}
          value={name}
          onChangeText={(value) => {
            setName(value);
            setFieldErrors((current) => ({ ...current, name: undefined }));
          }}
          error={fieldErrors.name}
          disabled={submitting}
          inputRef={nameRef}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={submit}
          testID="create-team-name"
        />
        <SelectField
          label={createTeamCopy.timeZoneLabel}
          helper={createTeamCopy.timeZoneHelper}
          value={timeZone}
          placeholder={createTeamCopy.timeZonePlaceholder}
          error={fieldErrors.timeZone}
          disabled={submitting}
          onPress={() => setPickerOpen(true)}
          testID="create-team-time-zone"
        />
      </View>
      {banner}
      <Spacer />
      <Button
        label={createTeamCopy.submit}
        loading={submitting}
        loadingLabel={createTeamCopy.submitting}
        disabled={!online}
        onPress={submit}
        testID="create-team-submit"
      />
      <TimeZonePicker
        visible={pickerOpen}
        zones={timeZones}
        selected={timeZone}
        onSelect={(zone) => {
          setTimeZone(zone);
          setFieldErrors((current) => ({ ...current, timeZone: undefined }));
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </Screen>
  );
}
