import { router } from 'expo-router';
import { useState } from 'react';
import { useMe } from '../../../auth/useMe';
import { settingsCopy } from '../../../settings/settingsCopy';
import { checkQuietHours } from '../../../settings/settingsDisplay';
import { useChangeSetting, useSettings } from '../../../settings/useSettings';
import { timeZones } from '../../../teams/timeZones';
import { useTeams } from '../../../teams/useTeams';
import { useSessionStore } from '../../../state/sessionStore';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';
import { SelectField } from '../../../ui/SelectField';
import { StatusBanner } from '../../../ui/StatusBanner';
import { TextField } from '../../../ui/TextField';
import { TimeZonePicker } from '../../../ui/TimeZonePicker';

/**
 * Quiet hours (Figma 09 Settings, "quiet-hours" 9:237). Start and end are typed as 24-hour times (a native time picker would need a new build), and the
 * time zone is the person's own setting. "Save quiet hours" sends the ONE quiet-hours setting (on, start, end together) and returns to Settings, which
 * shows it saving and then saved or restored; "Turn quiet hours off" sends the same setting with it off. A time zone chosen here is its own change, sent at
 * once. The server stores all of it; WHEN to hold a notification back is decided by the server's push job, later (ADR 0024), never by the app.
 */
export default function QuietHoursScreen() {
  const me = useMe();
  const userId = me.data?.id;
  const settings = useSettings(userId);
  const teams = useTeams(userId);
  const selectedTeamId = useSessionStore((s) => s.selectedTeamId);
  const team = teams.data?.find((t) => t.id === selectedTeamId) ?? null;
  const quiet = useChangeSetting(userId, 'quietHours');
  const timeZone = useChangeSetting(userId, 'timeZone');

  const data = settings.data;
  // What the person has typed; until they type, the fields show the server's copy.
  const [typed, setTyped] = useState<{ start?: string; end?: string }>({});
  const [errors, setErrors] = useState<{ start?: string; end?: string }>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const start = typed.start ?? data?.quietHours.value.start ?? '';
  const end = typed.end ?? data?.quietHours.value.end ?? '';

  function leave() {
    if (router.canGoBack()) router.back();
    else router.replace('/account');
  }

  function save(enabled: boolean) {
    if (!data) return;
    // Turning off keeps the times already saved; only "Save" checks what was typed.
    const checked = enabled ? checkQuietHours({ start, end }) : { values: data.quietHours.value, errors: {} };
    if (!checked.values) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const result = quiet.change({ enabled, start: checked.values.start, end: checked.values.end });
    // Started: Settings shows it saving. Offline: nothing was sent and Settings says so. Either way the answer is on that screen.
    if (result !== 'busy') leave();
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={settingsCopy.quietHours.title} subtitle={settingsCopy.quietHours.subtitle} teamName={team?.name} />
      <TextField
        label={settingsCopy.quietHours.startLabel}
        value={start}
        onChangeText={(text) => setTyped((t) => ({ ...t, start: text }))}
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        trailingIcon="clock"
        error={errors.start}
        helper={settingsCopy.quietHours.timeHelper}
        disabled={!data}
        testID="quiet-start"
      />
      <TextField
        label={settingsCopy.quietHours.endLabel}
        value={end}
        onChangeText={(text) => setTyped((t) => ({ ...t, end: text }))}
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        trailingIcon="clock"
        error={errors.end}
        disabled={!data}
        testID="quiet-end"
      />
      <SelectField
        label={settingsCopy.quietHours.timeZoneLabel}
        value={data?.timeZone.value ?? null}
        placeholder={settingsCopy.timeZoneUnset}
        helper={data && data.timeZone.value === null ? settingsCopy.timeZoneHelper : undefined}
        disabled={!data || timeZone.pending}
        onPress={() => setPickerOpen(true)}
        testID="quiet-time-zone"
      />
      <StatusBanner tone="info" title={settingsCopy.quietHours.infoTitle} body={settingsCopy.quietHours.infoBody} />
      <Spacer />
      {data?.quietHours.value.enabled ? (
        <Button label={settingsCopy.quietHours.turnOff} variant="secondary" disabled={quiet.pending} onPress={() => save(false)} testID="quiet-off" />
      ) : null}
      <Button
        label={settingsCopy.quietHours.save}
        loading={quiet.pending}
        loadingLabel={settingsCopy.quietHours.saving}
        disabled={!data}
        onPress={() => save(true)}
        testID="quiet-save"
      />
      <TimeZonePicker
        title={settingsCopy.timeZonePickerTitle}
        visible={pickerOpen}
        zones={timeZones}
        selected={data?.timeZone.value ?? null}
        onClose={() => setPickerOpen(false)}
        onSelect={(zone) => {
          setPickerOpen(false);
          void timeZone.change(zone);
        }}
      />
    </Screen>
  );
}
