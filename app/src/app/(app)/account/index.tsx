import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ApiError } from '../../../api/errors';
import { bannerCopy } from '../../../auth/copy';
import { useMe } from '../../../auth/useMe';
import { SettingGroup, SettingRow } from '../../../settings/SettingRow';
import { settingsCopy } from '../../../settings/settingsCopy';
import { describeChange, formatQuietHours, languageLabel, onOff, ownsATeam, settingLabel, settingsHeader, themeLabel } from '../../../settings/settingsDisplay';
import { THEME_SETTINGS, type SettingChange, type ThemeSetting } from '../../../settings/settingsResponses';
import { useChangeSetting, useIsAnySettingPending, useSettings } from '../../../settings/useSettings';
import { useScheduleContext } from '../../../shifts/useScheduleContext';
import { useSessionStore } from '../../../state/sessionStore';
import { LANGUAGE_SETTINGS } from '../../../settings/settingsResponses';
import { timeZones } from '../../../teams/timeZones';
import { useTeams } from '../../../teams/useTeams';
import { space } from '../../../theme';
import { AppNav } from '../../../ui/AppNav';
import { Button } from '../../../ui/Button';
import { ListLoadingFooter } from '../../../ui/ListLoadingFooter';
import { OptionSheet } from '../../../ui/OptionSheet';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';
import { SelectField } from '../../../ui/SelectField';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { TimeZonePicker } from '../../../ui/TimeZonePicker';
import { useOnline } from '../../../ui/useOnline';

/**
 * Settings (Figma 09 Settings 9:205, with saving 108:128, error 9:289, offline 108:2603, saved 9:258 and dark 108:3172): quiet hours, the three notification
 * types, theme, time zone and language. All of it is the SERVER's copy (GET /settings, refetched when the app opens and returns to the foreground); the app
 * only shows it. Each change is its own optimistic update with rollback (`useChangeSetting`): the row shows the new value at once and is disabled until the
 * server answers, a failure puts back only that field and says so, and nothing is queued offline. The Billing row is shown to someone who owns a team (the roles
 * are the server's answer from GET /teams; the setting is inert until payments exist).
 */
export default function SettingsScreen() {
  const online = useOnline();
  const me = useMe();
  // Whether to offer "Plan & billing": the server's `billing.manage` answer (the Owner alone). The server checks again on every billing request.
  const { detail: teamDetail } = useScheduleContext();
  const userId = me.data?.id;
  const settings = useSettings(userId);
  const teams = useTeams(userId);
  const selectedTeamId = useSessionStore((s) => s.selectedTeamId);
  const notice = useSessionStore((s) => s.ui.settingsNotice);
  const setNotice = useSessionStore((s) => s.setSettingsNotice);
  const team = teams.data?.find((t) => t.id === selectedTeamId) ?? null;

  const saving = useIsAnySettingPending(userId);
  const shiftChanges = useChangeSetting(userId, 'notifyShiftChanges');
  const swapUpdates = useChangeSetting(userId, 'notifySwapUpdates');
  const billing = useChangeSetting(userId, 'notifyBilling');
  const theme = useChangeSetting(userId, 'theme');
  const timeZone = useChangeSetting(userId, 'timeZone');
  const language = useChangeSetting(userId, 'language');
  const quiet = useChangeSetting(userId, 'quietHours');

  const [sheet, setSheet] = useState<'theme' | 'language' | 'timeZone' | null>(null);

  // What was said about a change belongs to the visit: leaving Settings clears it. (The quiet-hours screen opens ON TOP of this one, so a save made there is
  // reported here when it answers.)
  useEffect(() => () => setNotice(null), [setNotice]);

  const data = settings.data;
  const header = settingsHeader({ saving, notice, timeZone: data?.timeZone.value ?? null });

  /** "Try again": sends exactly what the person tried, through the same checks as the first time. */
  function retry(change: SettingChange) {
    switch (change.key) {
      case 'notifyShiftChanges':
        return void shiftChanges.change(change.value);
      case 'notifySwapUpdates':
        return void swapUpdates.change(change.value);
      case 'notifyBilling':
        return void billing.change(change.value);
      case 'theme':
        return void theme.change(change.value);
      case 'timeZone':
        return void timeZone.change(change.value);
      case 'language':
        return void language.change(change.value);
      case 'quietHours':
        return void quiet.change(change.value);
    }
  }

  let body: React.ReactNode;
  if (data) {
    body = (
      <>
        <SettingGroup title={settingsCopy.group}>
          <SettingRow
            label={settingLabel.quietHours}
            value={saving && quiet.pending ? `${settingsCopy.saving.inRow} ${formatQuietHours(data.quietHours.value)}` : formatQuietHours(data.quietHours.value)}
            disabled={quiet.pending}
            onPress={() => router.push('/account/quiet-hours')}
            testID="setting-quiet-hours"
          />
          <SettingRow
            label={settingLabel.notifyShiftChanges}
            value={onOff(data.notifyShiftChanges.value)}
            checked={data.notifyShiftChanges.value}
            disabled={shiftChanges.pending}
            onPress={() => void shiftChanges.change(!data.notifyShiftChanges.value)}
            testID="setting-shift-changes"
          />
          <SettingRow
            label={settingLabel.notifySwapUpdates}
            value={onOff(data.notifySwapUpdates.value)}
            checked={data.notifySwapUpdates.value}
            disabled={swapUpdates.pending}
            onPress={() => void swapUpdates.change(!data.notifySwapUpdates.value)}
            testID="setting-swap-updates"
          />
          {ownsATeam(teams.data) ? (
            <SettingRow
              label={settingsCopy.billingRow}
              value={onOff(data.notifyBilling.value)}
              checked={data.notifyBilling.value}
              disabled={billing.pending}
              onPress={() => void billing.change(!data.notifyBilling.value)}
              testID="setting-billing"
            />
          ) : null}
          <SettingRow
            label={settingLabel.theme}
            value={themeLabel(data.theme.value)}
            disabled={theme.pending}
            onPress={() => setSheet('theme')}
            testID="setting-theme"
          />
        </SettingGroup>
        {saving ? <ListLoadingFooter label={settingsCopy.saving.footer} /> : null}
        <SelectField
          label={settingsCopy.timeZoneLabel}
          value={data.timeZone.value}
          placeholder={settingsCopy.timeZoneUnset}
          helper={data.timeZone.value === null ? settingsCopy.timeZoneHelper : undefined}
          disabled={timeZone.pending}
          onPress={() => setSheet('timeZone')}
          testID="setting-time-zone"
        />
        <SelectField
          label={settingsCopy.languageLabel}
          value={languageLabel(data.language.value)}
          placeholder={settingsCopy.languageLabel}
          disabled={language.pending}
          onPress={() => setSheet('language')}
          testID="setting-language"
        />
      </>
    );
  } else if (settings.isError || !online) {
    // No copy of the settings yet. Offline says so; any other failure offers another try. Neither blocks the other tabs.
    const reference = settings.error instanceof ApiError && settings.error.requestId ? `${bannerCopy.referencePrefix}${settings.error.requestId}` : undefined;
    body = !online ? (
      <StatusBanner tone="warning" title={settingsCopy.loadOffline.title} body={settingsCopy.loadOffline.body} />
    ) : (
      <>
        <StatusBanner tone="error" title={settingsCopy.loadFailed.title} body={settingsCopy.loadFailed.body} reference={reference} />
        <Button label={settingsCopy.loadFailed.retry} variant="secondary" onPress={() => void settings.refetch()} testID="settings-retry" />
      </>
    );
  } else {
    body = <ListLoadingFooter label={settingsCopy.loading} />;
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={header.title} subtitle={header.subtitle} teamName={team?.name} />
      {notice?.kind === 'failed' ? (
        <View style={{ gap: space[12] }}>
          {notice.previous ? (
            <Text variant="body" tone="danger" testID="settings-previous">
              {settingLabel[notice.previous.key]}: {settingsCopy.failed.previous}
              {describeChange(notice.previous, { timeZone: data?.timeZone.value ?? null })}
            </Text>
          ) : null}
          <StatusBanner
            tone={notice.reason === 'offline' ? 'warning' : 'error'}
            title={notice.reason === 'offline' ? settingsCopy.offline.bannerTitle : settingsCopy.failed.bannerTitle}
            body={notice.reason === 'offline' ? settingsCopy.offline.bannerBody : settingsCopy.failed.bannerBody}
            reference={notice.requestId ? `${bannerCopy.referencePrefix}${notice.requestId}` : undefined}
            testID="settings-failed"
          />
          <Button label={settingsCopy.failed.retry} variant="secondary" onPress={() => retry(notice.change)} testID="settings-try-again" />
        </View>
      ) : null}
      {notice?.kind === 'saved' && !saving ? (
        <StatusBanner tone="info" title={settingsCopy.saved.banner} body={settingsCopy.saved.body} testID="settings-saved" />
      ) : null}
      {body}
      <Spacer />
      {teamDetail.data?.canManageBilling ? <Button label="Plan & billing" variant="secondary" onPress={() => router.push('/billing')} testID="settings-billing" /> : null}
      <Button label={settingsCopy.account} variant="secondary" onPress={() => router.push('/account/sessions')} testID="settings-account" />
      <AppNav selected="settings" />

      <OptionSheet
        visible={sheet === 'theme'}
        title={settingsCopy.themeSheetTitle}
        options={THEME_SETTINGS.map((value) => ({ value, label: themeLabel(value) }))}
        selected={data?.theme.value ?? null}
        onClose={() => setSheet(null)}
        onSelect={(value) => {
          setSheet(null);
          void theme.change(value as ThemeSetting);
        }}
      />
      <OptionSheet
        visible={sheet === 'language'}
        title={settingsCopy.languageSheetTitle}
        options={LANGUAGE_SETTINGS.map((value) => ({ value, label: languageLabel(value) }))}
        selected={data?.language.value ?? null}
        onClose={() => setSheet(null)}
        onSelect={(value) => {
          setSheet(null);
          void language.change(value);
        }}
      />
      <TimeZonePicker
        title={settingsCopy.timeZonePickerTitle}
        visible={sheet === 'timeZone'}
        zones={timeZones}
        selected={data?.timeZone.value ?? null}
        onClose={() => setSheet(null)}
        onSelect={(zone) => {
          setSheet(null);
          void timeZone.change(zone);
        }}
      />
    </Screen>
  );
}
